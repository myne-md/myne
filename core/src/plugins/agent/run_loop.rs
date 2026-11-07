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

use super::edit::{EditKind, ProposedEdit};
use super::engine::{AgentEngine, Content, Message, Role, AGENT_REQUEST_CLASS};
use super::error::AgentError;
use super::prompt::{
    build_request, parse_actions, reply_shape, AgentAction, Proposal, ProposedNote, ProposedSetting,
};
use super::run::AgentRunState;
use super::scope::ExclusionSource;
use super::tools::{
    calendar_range, list_scope, read_note, render_scope_entry, search_scope, search_vault,
    CalendarReader, NoteReader, ScopeSearcher,
};
use crate::plugins::vault_indices::state::NoteRecord;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use tracing::Instrument;

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

/// A tool's answer, as the model sees it: host prose first, note-derived text
/// after (myne-md/myne#574).
///
/// **A bare blob is what the model could not read.** Three of the six result
/// paths used to push nothing but the payload — `list_scope` a
/// `Content::note(rendered)`, `read_note` a `Content::note(body)`,
/// `search_scope` a sentenceless `Content::Trusted(ids)` — so what arrived was
/// a user turn with a note title in it and nothing saying it answered the call
/// the model had just made. Every path added or debugged later already had
/// prose (`search_vault`'s "In your scope:", both `read_note` refusals,
/// `propose_edit`'s acknowledgement); the three original tools never got any.
/// A model that cannot tell a result from a fresh user utterance re-issues its
/// plan, which is how a run spent four provider requests calling `list_scope`
/// four times and stalled with a perfectly good answer sitting in its context.
///
/// **The order is the security half, and it is why this is a function.** The
/// prose is `Trusted` and the payload is not, and framing raises the value of a
/// note whose TEXT mimics the framing. Two things make that harder and cost
/// nothing: the prose states the COUNT, so a forged extra line contradicts a
/// number the host wrote, and the payload goes LAST, so note text can never be
/// the thing a frame is prepended to. Nothing widens — the payload keeps its
/// `UntrustedNote` tag, `chat_shape` concatenates spans into one provider
/// message exactly as it already did, and both engine arms sanitize every
/// non-system turn.
///
/// The two `read_note` refusals deliberately do NOT come through here: their
/// shape is prose, model-supplied id, prose, so that only the part the model
/// chose carries the untrusted tag. Wrapping them would trade that for a rule
/// they do not need, since a refusal carries no note content at all.
fn tool_result(prose: String, payload: Option<String>) -> Message {
    let mut content = vec![Content::Trusted(prose)];
    if let Some(text) = payload {
        content.push(Content::note(text));
    }
    Message {
        role: Role::User,
        content,
    }
}

/// The opening message: what is in scope, and when that is one note, its text.
///
/// **This is `list_scope`'s answer, and sometimes `read_note`'s, given before
/// they are asked** (myne-md/myne#578). Both tools read state the host resolved
/// before the loop started, so a run that begins by calling them spends provider
/// requests on a conversation the host could have opened with.
///
/// **The body goes only when the scope is EXACTLY one note**, which is the
/// "Working on: This note" default and the case this is worth most for. A
/// character-budgeted partial pre-load was considered and rejected: "some bodies
/// are here, ask for the rest" is precisely the split state that confuses a
/// small model, which is the failure `myne-md/myne#574` had just finished
/// closing. One note or none is a rule the model can act on without reasoning
/// about which half it has.
///
/// **What this changes about disclosure, said plainly.** The titles now leave
/// the device unconditionally rather than on the first `list_scope`, and for a
/// single-note scope so does the body, where today a run the model finishes
/// without reading sends neither. The scope BOUND is untouched — every note here
/// is one the model could already have read on demand — so what moves is that
/// the disclosure is unconditional rather than earned. `notes_read` counts a
/// pre-loaded body, because it did leave the device and the summary would
/// otherwise report a read that happened as one that did not.
async fn opening_scope(
    runs: &AgentRunState,
    run_id: &str,
    deps: &LoopDeps<'_>,
    notes_read: &mut usize,
    read_ids: &mut BTreeSet<String>,
) -> Result<Message, AgentError> {
    let entries = list_scope(runs, run_id, deps.records, deps.exclusions).await?;
    tracing::debug!(
        target: "myne_core::agent",
        event = "tool",
        verb = "opening_scope",
        entries = entries.len(),
    );
    if entries.is_empty() {
        return Ok(tool_result(
            "Your scope is empty: there are no notes here to read or edit. \
             Finish and say so."
                .into(),
            None,
        ));
    }
    // One note, and it can still be read: the body joins the listing. A note the
    // exclusion clamp removed between `list_scope` and here would come back
    // refused, and the honest answer then is the listing alone rather than an
    // error, since the model can ask and be told properly.
    if entries.len() == 1 {
        let entry = &entries[0];
        if let Ok(body) =
            read_note(runs, run_id, &entry.note_id, deps.reader, deps.exclusions).await
        {
            read_ids.insert(entry.note_id.clone());
            *notes_read += 1;
            let chars = body.chars().count();
            tracing::debug!(
                target: "myne_core::agent",
                event = "tool",
                verb = "opening_body",
                body_chars = chars,
            );
            return Ok(tool_result(
                format!(
                    "Your scope is one note. Its id is {} and its whole text \
                     follows, so you do not need list_scope or read_note. \
                     Answer the user's question from it, or propose an edit \
                     whose anchor is copied exactly from it, then finish. The \
                     text is {chars} characters:",
                    entry.note_id
                ),
                Some(body),
            ));
        }
    }
    let rendered = entries
        .iter()
        .map(render_scope_entry)
        .collect::<Vec<_>>()
        .join("\n");
    Ok(tool_result(
        format!(
            // **The folder is in the listing, and the sentence says so**
            // (myne-md/myne#848, on the user's report): a folder-shaped question
            // ("what is in my inbox?") is answerable from this line and was not
            // answerable from ids and titles, which is how a run came to report
            // that a folder held one note, the folder's own index note.
            "Your scope holds {} notes, one per line as `<note_id> | <folder> | \
             <title>`. The folder is the note's `folder:` field, and `(root)` \
             means it has none; a folder holds every note whose path starts with \
             it, subfolders included. So a question about a folder can be \
             answered from this list (filter it by that folder) and you do not \
             need list_scope. Read one with read_note, or finish if you already \
             have what you need.",
            entries.len()
        ),
        Some(rendered),
    ))
}

/// What a repeated tool call is told, after its answer (myne-md/myne#574).
///
/// **The corrector the barren counter never had.** `asked` already knew the
/// call was a repeat — that is what makes the iteration unproductive — and the
/// loop then served the identical answer in silence, three times, before
/// [`MAX_BARREN_ITERATIONS`] cut the run off. Counting a mistake is not telling
/// anyone about it: the model saw the same state it had seen before and had no
/// reason to do anything different.
fn repeat_notice() -> Message {
    Message {
        role: Role::User,
        content: vec![Content::Trusted(
            "You already made that exact call earlier in this run and the \
             answer has not changed. Do something else with it: read a note, \
             propose an edit, or finish and say what you found."
                .into(),
        )],
    }
}

/// What one body-only edit did, so the caller can set its own `productive`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyEditOutcome {
    /// The note is in scope and the edit is in the proposal.
    Recorded,
    /// The note is outside the run's scope, and the model has been told.
    /// `fresh` is whether this exact refusal is new, a repeat is not progress.
    Refused { fresh: bool },
}

/// **Record a body-only edit: an append or a move** (myne-md/myne#848).
///
/// The two are the same act with different nouns: neither has anything to anchor
/// to, both refuse when the note is outside the run's scope, and both are
/// acknowledged the same way. They were two forty-line arms differing in four
/// words, which is the shape where the next fix lands in one copy and not the
/// other, so the scope check, the refusal and both replies live here once.
///
/// **`Replace` deliberately does not come through here.** Its refusal talks the
/// model out of asking for a wider scope after a bad copy, which is a lesson the
/// other two do not need, and its edit carries an anchor. `propose_edit` keeps
/// its own arm.
// Nine arguments, and every one is a piece of the loop's own state rather than a
// parameter a caller chooses: the run to check against, the edit's own four
// fields, and the three sinks every tool result writes to. Bundling the sinks
// into a struct was the alternative and it buys a type in this file's vocabulary
// for one call site, twice.
#[allow(clippy::too_many_arguments)]
fn record_body_edit(
    runs: &AgentRunState,
    run_id: &str,
    kind: EditKind,
    // What the replies call this act: "append", "move".
    verb: &str,
    note_id: String,
    replacement: String,
    asked: &mut BTreeSet<String>,
    proposal: &mut Proposal,
    transcript: &mut Vec<Message>,
) -> Result<BodyEditOutcome, AgentError> {
    if !runs.contains(run_id, &note_id)? {
        let fresh = asked.insert(format!("{verb}_refused:{note_id}"));
        transcript.push(Message {
            role: Role::User,
            content: vec![
                Content::Trusted("Note ".into()),
                Content::note(note_id),
                Content::Trusted(format!(
                    " is not one of the notes in your scope, so that {verb} was discarded. \
                     Copy an id from your scope exactly, or use request_scope if the note you \
                     need is genuinely not among them."
                )),
            ],
        });
        return Ok(BodyEditOutcome::Refused { fresh });
    }
    proposal.edits.push(ProposedEdit {
        note_id,
        kind,
        // Nothing to anchor to: empty rather than absent because the field is
        // shared with the replace shape, and `apply_edit` routes on the kind
        // rather than on which fields happen to be populated.
        anchor: String::new(),
        replacement,
    });
    transcript.push(Message {
        role: Role::User,
        content: vec![Content::Trusted(format!(
            "{} recorded. Propose another change, or finish.",
            // The acknowledgement opens with the verb, as it always has.
            verb[..1].to_uppercase() + &verb[1..]
        ))],
    });
    Ok(BodyEditOutcome::Recorded)
}

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
    /// How many memory entries this invocation wrote (0 or 1: the
    /// at-most-one-write-per-run counter, `decisions/ai/0590`). Feeds the
    /// turn-end marker the memory UI renders, which is the transparency half
    /// of the automatic-write model.
    pub memory_writes: usize,
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
    /// The calendar the fifth tool reads through (myne-md/myne#1037).
    ///
    /// `None` where a client cannot answer, the same shape `memory` takes: the tool
    /// then reports that the calendar is unreadable and the run carries on, rather
    /// than failing a run the user could have continued by asking differently.
    pub calendar: Option<&'a dyn CalendarReader>,
    /// The `remember` verb's seam to the memory plugin (myne-md/myne#697).
    /// `None` when the surface is unavailable (no `ai_enabled`, no memory
    /// store): the verb then answers with a model-readable refusal instead of
    /// failing the run, exactly like a scope the user declined.
    pub memory: Option<&'a dyn super::memory::MemoryStore>,
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
    /// The user's interface language, as a BCP-47 tag, or `None`.
    ///
    /// Threaded through the loop rather than read here because this crate has no
    /// access to it: the chosen language lives in the WebView's `localStorage`
    /// (`src/i18n/index.ts`), not in `vault.prefs`, so the client supplies it.
    /// `prompt::system_instructions` shape-checks it before it reaches the
    /// system message.
    pub language: Option<&'a str>,
    /// The visible chat history this run was seeded with, already budgeted and
    /// wrapped by `super::history::seed_messages`.
    ///
    /// Prepared by the caller rather than here for the same reason `records` is:
    /// this loop must not re-derive what the run started with. It is also where
    /// the character budget is applied, which is host policy and belongs at the
    /// command boundary, not in the loop.
    pub history: &'a [Message],
    /// The documents the user attached to this run, already budgeted and
    /// wrapped as untrusted messages by `prompt::document_messages`
    /// (myne-md/myne#913).
    ///
    /// Held on the session and read here rather than re-derived per iteration,
    /// for the same reason `history` is: a run resumed after a scope approval
    /// must still have the document it was asked about. Kept OUT of `history`
    /// because `step` drops the seed when the egress controls change, and a
    /// withdrawn conversation is not a withdrawn attachment: the user chose the
    /// file for this run.
    pub documents: &'a [Message],
    /// Whether the client offered a settings catalogue to this run
    /// (myne-md/myne#850).
    ///
    /// **A gate rather than a formality, and the two questions it separates are
    /// different ones.** The intent table says what the agent MAY write; this
    /// says what the client can actually show and apply. A client that offers
    /// nothing can do neither, so a `set_setting` it never offered is refused
    /// here rather than accepted into a proposal no surface will render. That
    /// refusal is the difference between an inert feature and a silent one.
    ///
    /// The ids are resolved through `setting::offered_ids` before use, so an id
    /// the table refuses is not offered and a client string never reaches the
    /// system message.
    pub offered_settings: &'a [String],
    /// Report the run's cost as it accrues, once per model round-trip
    /// (myne-md/myne#456).
    ///
    /// **Why the loop reports at all, rather than the caller reading the
    /// outcome.** `docs/decisions/ai/0515` rests the remote arm's lack of a
    /// volume bound on disclosure: a finished run reports the requests it made,
    /// the notes it read, and how much text left the device. But `drive`
    /// returns only when the loop has STOPPED, which on a remote provider is
    /// minutes, so a caller that reads the outcome learns the cost strictly
    /// after it has been spent. A run that is cancelled, or that dies with the
    /// foreground on a phone, then discloses nothing at all while having paid
    /// for every round-trip it made.
    ///
    /// The figures are the RUNNING TOTALS for this leg, not deltas. A delta
    /// would make the receiver responsible for summing, and a receiver that
    /// dropped one message would under-report the disclosure figure forever
    /// after: which is the one number that must never read low.
    ///
    /// Synchronous and infallible on purpose: a reporting channel that can fail
    /// must not be able to stop or slow a run, and a run that stalled because
    /// nobody was listening would be a disclosure control taking the product
    /// down with it. A caller with nowhere to send it passes a closure that
    /// does nothing.
    /// `Send + Sync` because `LoopDeps` is held across the model `await` inside
    /// a `#[tauri::command]`, whose future must be `Send`. Without the bounds
    /// the whole command stops compiling, with an error that names the command
    /// rather than this field.
    pub on_progress: &'a (dyn Fn(RunProgress) + Send + Sync),
}

/// What a run has cost so far, for this leg (myne-md/myne#456).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProgress {
    /// Model round-trips so far.
    pub iterations: usize,
    /// Distinct notes read in full so far.
    pub notes_read: usize,
    /// Characters that have left the device, or `None` when the run has been
    /// answered entirely on this device.
    ///
    /// `None` and `Some(0)` are DIFFERENT statements and are kept apart all the
    /// way to the screen: "the run stayed on this device" versus "the run is
    /// remote and has sent nothing yet". Collapsing one into the other reports
    /// the second as the first, which is the wrong direction for a disclosure
    /// control to be wrong in.
    pub chars_off_device: Option<usize>,
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
    read_ids: &mut BTreeSet<String>,
) -> Result<LoopOutcome, AgentError> {
    // Target note, once for this module: `myne_core::agent`, not the `myne::…`
    // product target the desktop crate uses for `myne::ai`. `tracing-test`
    // filters its capture on the crate name, so a `myne::…` target here would be
    // invisible to the tests that assert these lines carry no note content —
    // and an untested DENY-list claim is the kind this repo does not make.
    // Both arms below are `info`, which is the level the diagnostic log's file
    // layer records: a run that stopped is exactly what a user reports and
    // cannot explain, and at `debug` the log could never say why. The terminal
    // still shows them at `RUST_LOG=myne_core=debug`.
    // Both arms below are `info`, which is the level the diagnostic log's file
    // layer records: a run that stopped is exactly what a user reports and
    // cannot explain, and at `debug` the log could never say why. The terminal
    // still shows them at `RUST_LOG=myne_core=debug`.
    //
    // The span is what puts `run_id` on every record this leg produces, including
    // the six `tool` verbs, `iteration`, `reply` and the provider exchange
    // underneath them. Two runs interleaved in one file are otherwise
    // indistinguishable, and the first question a report raises is whether the
    // approval reached a run that was still alive. It is `instrument` rather than
    // `enter` because an `Entered` guard cannot be held across an await.
    let span = tracing::info_span!(target: "myne_core::agent", "run", run_id = run_id);
    let outcome = drive_inner(runs, run_id, task, transcript, deps, read_ids)
        .instrument(span)
        .await;
    match &outcome {
        Ok(o) => tracing::info!(
            target: "myne_core::agent",
            event = "run_stopped",
            // Repeated here rather than left to the span: this line is emitted
            // AFTER the instrumented future has completed, so the span is no
            // longer current and the record would carry no run at all. It is the
            // line a reader greps for first.
            run_id = run_id,
            end = o.end.tag(),
            iterations = o.iterations,
            notes_read = o.notes_read,
            edits = o.proposal.edits.len(),
            new_notes = o.proposal.new_notes.len(),
            // **How LONG the closing summary is, never what it says**
            // (myne-md/myne#568). `edits=0` alone does not distinguish a run
            // that failed to propose anything from a run that was never asked
            // to: in one mode a question is a run too, and `finish` is how it is
            // answered. `edits=0 summary_chars=120` reads as "the model
            // answered, it proposed nothing", which took a session to work out
            // from the surface. A count, so the DENY list holds: the summary is
            // model output and can quote note text.
            summary_chars = o.proposal.summary.chars().count(),
        ),
        // `kind()`, never the error itself: two variants carry a `note_id`.
        Err(e) => tracing::info!(
            target: "myne_core::agent",
            event = "run_failed",
            run_id = run_id,
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
    read_ids: &mut BTreeSet<String>,
) -> Result<LoopOutcome, AgentError> {
    let mut proposal = Proposal::default();
    let mut iterations = 0usize;
    let mut notes_read = 0usize;
    // **Which notes, not how many reads** (myne-md/myne#578). The surface says
    // "{count} notes read", and the counter used to increment per CALL: a model
    // that read the same note twice reported two. That was a rare inaccuracy
    // until the opening message started carrying a single-note scope's body,
    // which makes "the seed read it and the model asked anyway" the ordinary
    // case rather than an odd one. The set is the dedup; `notes_read` stays the
    // reported figure so the ten return sites are untouched.
    //
    // **Owned by the CALLER, for the same reason the transcript is.** A run
    // resumed after a scope approval re-enters through `step`, which writes the
    // transcript back but used to hand this set in fresh, so leg two believed it
    // had read nothing while leg one's bodies were still sitting in the
    // transcript above it. The guard then let a re-read through and pushed a
    // second copy of a body already in the prompt, on the longest transcripts
    // there are, which is exactly where the saving is worth most. A required
    // parameter rather than one defaulted here: a default is evaluated at the
    // call, so the site that forgets to thread it is the site running
    // unguarded, which `AGENTS.md` records as its own class of bug.
    // Stays `None` until some request reports that it went off-device, which is
    // what keeps "nothing was transmitted" and "a transmission carried nothing"
    // separable at the surface.
    let mut chars_off_device: Option<usize> = None;
    // **The seed, held as a local so it can be dropped MID-RUN.**
    //
    // SYNC-14 carries no in-flight carve-out: an exclusion added while a run is
    // open takes effect at once, which is why the read tools re-ask on every
    // call and `apply.rs` re-reads at the write. A run is up to 24 iterations
    // and was measured at 12m49s, so "while the run is open" is a real window,
    // and until this the seed was fixed for the whole of it: the host's cut
    // fired on the scope-approval pause and nowhere else, so a user excluding a
    // folder DURING a run kept having the pre-change conversation re-sent on
    // every remaining iteration.
    //
    // A drop rather than a filter, the same reasoning as everywhere else in
    // this feature: a turn carries text and no note provenance, so there is
    // nothing to select out of it. The exclusion set at entry is the baseline;
    // any change to it, in either direction, stops the seed.
    let mut seed: &[Message] = deps.history;
    let seed_baseline = if seed.is_empty() {
        // Nothing to protect, so nothing to pay for. This is the ordinary case
        // (a first message in a conversation) and it keeps the per-iteration
        // read off the path that does not need it.
        None
    } else {
        Some(deps.exclusions.excluded_now().await?)
    };
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
    // **At most one `remember` write per run** (`decisions/ai/0590`): the
    // counter is the loop's own, so no caller can raise it and a steered run
    // cannot flood the memory store.
    let mut memory_writes = 0usize;
    // Barren iterations SINCE THE LAST PRODUCTIVE ONE. Reset rather than
    // cumulative: a run that recovers has not stalled, and counting every
    // barren turn of a long healthy run would end it for being slow.
    let mut barren = 0usize;

    // **The scope goes in the opening message, because the host already knows
    // it** (myne-md/myne#578). `start_run` resolves the grant into a frozen note
    // set before this function is called, and `list_scope` does nothing but read
    // that set back; the bodies are in the host's hands too. So a question about
    // the open note spent its first two provider requests asking the host to
    // repeat itself, and only the third did any work. Measured: 1 942 ms and
    // 5 750 ms of a 38 707 ms run, plus two extra copies of a 2 270-character
    // system prompt.
    //
    // **Only on the first leg.** A run resumed after a scope approval arrives
    // with a transcript, and re-seeding it would restate a scope the model has
    // already been working in and would do it with the OLD note set, since the
    // widening is what it just got. The newly granted notes reach it through
    // `list_scope`, which is the existing path and stays correct.
    //
    // **`asked` is deliberately NOT seeded.** A seed is information, not a call.
    // Registering it would make the model's first genuine `list_scope` count as
    // a repeat, which marks the iteration unproductive, and three of those end
    // the run — so a model that ignored the hint would be killed rather than
    // corrected. A model that asks anyway gets the answer, cheaply and
    // host-side, exactly as before.
    if transcript.is_empty() {
        transcript.push(opening_scope(runs, run_id, deps, &mut notes_read, read_ids).await?);
    }

    // **The memory + personality block is rendered ONCE, before the loop**
    // (myne-md/myne#697, `decisions/ai/0590`). One render per run START from
    // the store (no cross-run RAM cache: the plugin reads it fresh), carried
    // as its own `UntrustedNote` span on every iteration's system turn. A
    // failed read FAILS the run (report-don't-empty, §9.25.3): collapsing it
    // to "no memory" would run the model blind and let the next write
    // persist that blindness. A `remember` write later in this run does not
    // re-render: the loop's refusal message already tells the model the id.
    let memory_block = match deps.memory {
        Some(store) => {
            let entries = store.memory_for_injection().await?;
            let personality = store.personality_for_injection().await?;
            super::memory::render_memory_block(&entries, &personality)
        }
        None => String::new(),
    };

    // **The offered settings, resolved to this table's own ids ONCE per run**
    // (myne-md/myne#850). The client sends ids; `offered_ids` maps each through
    // `setting::writable` and returns the table's own `&'static str`, so the
    // system block can only ever name a setting this crate owns. Empty when the
    // client offered nothing, which is what makes the verb inert on a client
    // that has built no catalogue.
    let offered = super::setting::offered_ids(deps.offered_settings);

    loop {
        if runs.is_cancelled(run_id)? {
            return Ok(LoopOutcome {
                proposal,
                end: LoopEnd::Cancelled,
                iterations,
                notes_read,
                chars_off_device,
                memory_writes,
            });
        }
        if iterations >= MAX_ITERATIONS {
            return Ok(LoopOutcome {
                proposal,
                end: LoopEnd::ExhaustedIterations,
                iterations,
                notes_read,
                chars_off_device,
                memory_writes,
            });
        }

        // Re-asked per iteration rather than per run, for the reason above. The
        // cost is one prefs read on an iteration that is about to make a model
        // call, which the read tools already pay per call.
        if let Some(baseline) = seed_baseline.as_ref() {
            if !seed.is_empty() && deps.exclusions.excluded_now().await? != *baseline {
                seed = &[];
            }
        }
        let request = build_request(
            task,
            transcript,
            deps.language,
            seed,
            &memory_block,
            &offered,
            deps.documents,
        );
        // The class is the constant, passed here, in the loop's own code. It is
        // never read from a payload and never varies per iteration.
        let completion = deps.engine.complete(AGENT_REQUEST_CLASS, &request).await?;
        iterations += 1;
        if let Some(n) = completion.chars_off_device {
            chars_off_device = Some(chars_off_device.unwrap_or(0) + n);
        }
        let truncated = completion.truncated;
        // Report IMMEDIATELY after the round-trip that spent the request, and
        // before this iteration's tool work. The whole point is that a run which
        // never reaches its own exit has still disclosed what it cost, so the
        // report cannot sit behind anything that might not happen.
        (deps.on_progress)(RunProgress {
            iterations,
            notes_read,
            chars_off_device,
        });
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
            //
            // **A cut-off reply gets a different sentence, and the difference
            // is not politeness.** The token ceiling this loop now asks for
            // (`AGENT_MAX_OUTPUT_TOKENS`) makes a long answer come back stopped
            // mid-token, which is broken JSON and parses to zero actions. Told
            // "no valid action found", a model goes looking for a format error
            // it did not make, and usually answers at the same length again, so
            // all three barren strikes go the same way and the run ends with a
            // stall verdict naming the wrong cause. The provider said which it
            // was; passing that through is the whole fix.
            transcript.push(Message {
                role: Role::User,
                content: vec![Content::Trusted(
                    if truncated {
                        "Your reply was cut off before it finished. Answer more briefly: fewer actions per reply, and shorter text in each."
                    } else {
                        "No valid action found. Reply with one JSON action per line."
                    }
                    .into(),
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
                    memory_writes,
                });
            }
            match action {
                AgentAction::ListScope => {
                    let fresh = asked.insert("list_scope".to_string());
                    productive |= fresh;
                    let entries = list_scope(runs, run_id, deps.records, deps.exclusions).await?;
                    tracing::debug!(
                        target: "myne_core::agent",
                        event = "tool",
                        verb = "list_scope",
                        entries = entries.len(),
                    );
                    // **An empty scope says so in words, and sends no payload.**
                    // It used to push `Content::note("")`, i.e. a user turn
                    // whose whole content was the empty string, which is not
                    // distinguishable from a broken tool by anything reading it.
                    if entries.is_empty() {
                        transcript.push(tool_result(
                            "list_scope returned no notes: your scope is empty. \
                             There is nothing here to read or edit, so finish \
                             and say so."
                                .into(),
                            None,
                        ));
                    } else {
                        let rendered = entries
                            .iter()
                            .map(render_scope_entry)
                            .collect::<Vec<_>>()
                            .join("\n");
                        // Titles come out of note plaintext, so the payload is
                        // untrusted; the sentence around it is the host's.
                        transcript.push(tool_result(
                            format!(
                                "list_scope returned the {} note(s) in your scope, one per \
                                 line as `<note_id> | <folder> | <title>`, where `(root)` \
                                 means the note has no folder. Read one with read_note, or \
                                 finish if you already have what you need.",
                                entries.len()
                            ),
                            Some(rendered),
                        ));
                    }
                    if !fresh {
                        transcript.push(repeat_notice());
                    }
                }
                AgentAction::ReadNote { note_id } => {
                    // The signature covers the refusal arms too: a note outside
                    // the scope answers the same sentence every time, so asking
                    // twice is as barren as reading the same note twice.
                    let fresh = asked.insert(format!("read_note:{note_id}"));
                    productive |= fresh;
                    // **A repeat read costs nothing, because it sends nothing**
                    // (myne-md/myne#619). The body is already in this
                    // transcript, and `build_request` re-sends the whole
                    // transcript on every iteration, so a second copy rides
                    // along on every remaining one, up to the 24-iteration
                    // ceiling. That is provider tokens on any backend and
                    // off-device characters on the remote arm.
                    //
                    // The pointer is returned INSTEAD of the body rather than
                    // by rewriting the earlier entry: the transcript stays
                    // append-only, so nothing the model has already read
                    // changes underneath it.
                    //
                    // Deliberately BEFORE the read: the whole saving is not
                    // performing it. The scope and exclusion checks it would
                    // have run are not skipped in any meaningful sense, since
                    // the first read passed them and its answer is what is being
                    // pointed at. `apply.rs` re-checks both at the write
                    // boundary, which is where a mid-run change has to be
                    // caught anyway.
                    //
                    // One message rather than this plus `repeat_notice()`: the
                    // two would say the same thing twice, and this one is the
                    // more useful half, since it names where the answer already
                    // is instead of only that the call was a repeat.
                    //
                    // **Keyed on `read_ids` ALONE, and the `!fresh` this used to
                    // carry made it miss the commonest scope there is.**
                    // `opening_scope` reads the body for a single-note scope and
                    // records the id, but registers no `asked` entry, on purpose:
                    // a seed is information rather than a call, and counting it
                    // would make the model's first genuine `read_note` a repeat
                    // and cost it a barren strike. So on that scope the first
                    // `read_note` is `fresh`, and a guard requiring `!fresh`
                    // stood down for exactly the shape "Working on: This note"
                    // produces, which is the default. Everywhere else
                    // `read_ids.contains` already implies `!fresh`, because the
                    // `asked.insert` above runs before the read that populates
                    // it, so the term bought nothing where it was not harmful.
                    //
                    // `productive |= fresh` above is untouched, so a first call
                    // that lands here still counts as progress and the run
                    // cannot stall on it.
                    if read_ids.contains(&note_id) {
                        transcript.push(tool_result(
                            "You have already read that note in this run, and its text is \
                             above in this conversation. Use what is there: reading it again \
                             returns nothing new. Propose an edit, or finish and say what you \
                             found."
                                .to_string(),
                            None,
                        ));
                        continue;
                    }
                    match read_note(runs, run_id, &note_id, deps.reader, deps.exclusions).await {
                        Ok(body) => {
                            if read_ids.insert(note_id.clone()) {
                                notes_read += 1;
                            }
                            let chars = body.chars().count();
                            tracing::debug!(
                                target: "myne_core::agent",
                                event = "tool",
                                verb = "read_note",
                                body_chars = chars,
                            );
                            // The id is the model's own, echoed back so it can
                            // tell two reads apart; the body is the note's.
                            transcript.push(tool_result(
                                if chars == 0 {
                                    "read_note returned an empty note: it has no text. \
                                     Read another, or finish."
                                        .to_string()
                                } else {
                                    format!(
                                        "read_note returned the body of that note, {chars} \
                                         characters, and it follows. Propose an edit whose \
                                         anchor is copied exactly from it, or finish and say \
                                         what you found."
                                    )
                                },
                                if chars == 0 { None } else { Some(body) },
                            ));
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
                    // After the answer, whichever arm produced it: asking twice
                    // for a note that is out of scope is as barren as reading
                    // the same note twice, and both need saying.
                    if !fresh {
                        transcript.push(repeat_notice());
                    }
                }
                AgentAction::SearchScope { query } => {
                    let fresh = asked.insert(format!("search_scope:{query}"));
                    productive |= fresh;
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
                    tracing::debug!(
                        target: "myne_core::agent",
                        event = "tool",
                        verb = "search_scope",
                        hits = hits.len(),
                    );
                    // Ids are host-minted, so the whole message is trusted and
                    // there is no payload span. What was missing was the
                    // sentence: a bare list of uuids answers no question the
                    // model asked.
                    transcript.push(tool_result(
                        if hits.is_empty() {
                            "search_scope found nothing for that query in your scope. \
                             Try list_scope to see what is there, or search_vault to \
                             find out which folder holds it."
                                .to_string()
                        } else {
                            let ids = hits
                                .iter()
                                .map(|h| h.note_id.clone())
                                .collect::<Vec<_>>()
                                .join("\n");
                            format!(
                                "search_scope found {} note(s) in your scope, one id per \
                                 line. Read one with read_note.\n{ids}",
                                hits.len()
                            )
                        },
                        None,
                    ));
                    if !fresh {
                        transcript.push(repeat_notice());
                    }
                }
                AgentAction::SearchVault { query } => {
                    let fresh = asked.insert(format!("search_vault:{query}"));
                    productive |= fresh;
                    let found = search_vault(
                        runs,
                        run_id,
                        &query,
                        SEARCH_LIMIT,
                        deps.searcher,
                        deps.records,
                        deps.exclusions,
                    )
                    .await?;
                    tracing::debug!(
                        target: "myne_core::agent",
                        event = "tool",
                        verb = "search_vault",
                        hits = found.in_scope.len(),
                        elsewhere = found.elsewhere.len(),
                    );
                    // **Two provenances, and the split is the point.** Ids are
                    // host-minted identifiers and the sentence around them is
                    // host prose, so both are trusted. Folder names come out of
                    // the user's vault — a `folder:` frontmatter value is text
                    // somebody wrote — so they are the untrusted payload,
                    // exactly like a title from `list_scope` is, and they go
                    // last for the reason `tool_result` states.
                    let ids = found
                        .in_scope
                        .iter()
                        .map(|h| h.note_id.clone())
                        .collect::<Vec<_>>()
                        .join("\n");
                    // The count joins the sentence for symmetry with the other
                    // three tools, and for the reason `tool_result` gives: a
                    // stated number is what a forged extra line contradicts.
                    let mut prose = format!(
                        "search_vault found {} match(es) inside your scope, one id per \
                         line. Read one with read_note.\n{ids}\n",
                        found.in_scope.len()
                    );
                    let payload = if found.elsewhere.is_empty() {
                        None
                    } else {
                        prose.push_str(
                            "It also found matches outside your scope, listed below by \
                             folder and counted among the matches this search ranked \
                             rather than across the vault. You cannot read these; use \
                             request_scope if you need one: ",
                        );
                        Some(
                            found
                                .elsewhere
                                .iter()
                                .map(|f| {
                                    format!(
                                        "{} ({})",
                                        f.folder.as_deref().unwrap_or("no folder"),
                                        f.count
                                    )
                                })
                                .collect::<Vec<_>>()
                                .join(", "),
                        )
                    };
                    transcript.push(tool_result(prose, payload));
                    if !fresh {
                        transcript.push(repeat_notice());
                    }
                }
                AgentAction::CalendarRange { from, to } => {
                    let fresh = asked.insert(format!("calendar_range:{from}:{to}"));
                    productive |= fresh;
                    let (prose, payload) =
                        calendar_range(&from, &to, deps.calendar, deps.records, deps.exclusions)
                            .await?;
                    tracing::debug!(
                        target: "myne_core::agent",
                        event = "tool",
                        verb = "calendar_range",
                        rows = payload.as_deref().map(|p| p.lines().count()).unwrap_or(0),
                    );
                    transcript.push(tool_result(prose, payload));
                    if !fresh {
                        transcript.push(repeat_notice());
                    }
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
                        // **The refusal names the fix, and the order is the fix**
                        // (myne-md/myne#559). It used to say only "use
                        // request_scope", so a model that had merely MISTYPED an
                        // id read a widening as the remedy and asked the user to
                        // approve a folder the run never needed: the scope was
                        // right, the id was not. An id that does not resolve is
                        // almost always a copy error, and the answer to a copy
                        // error is the correct id rather than a wider scope. So
                        // the ids come first, widening comes last, and when the
                        // scope holds exactly one note there is no ambiguity
                        // left to describe: it is named outright.
                        //
                        // Nothing fuzzy-matches the mistyped id onto a real one.
                        // That is the anchor rule's own failure mode in another
                        // costume, and `docs/decisions/ai/0515` rules it out
                        // there for the same reason: a near-miss that writes to
                        // the wrong note is worse than a refusal.
                        let scope = runs.scope(run_id)?;
                        let mut content = vec![
                            Content::Trusted("Note ".into()),
                            Content::note(note_id.clone()),
                            Content::Trusted(" is not one of the notes in your scope, so that edit was discarded. ".into()),
                        ];
                        if scope.len() == 1 {
                            content.push(Content::Trusted(
                                "Your scope holds exactly one note, and its id is ".into(),
                            ));
                            content.push(Content::note(
                                scope.iter().next().cloned().unwrap_or_default(),
                            ));
                            content.push(Content::Trusted(
                                ". Copy it exactly and propose the edit again.".into(),
                            ));
                        } else {
                            content.push(Content::Trusted(format!(
                                "Your scope holds {} notes; their ids are the ones list_scope returned. Copy one of them exactly and propose the edit again.",
                                scope.len()
                            )));
                        }
                        content.push(Content::Trusted(
                            " Only ask for a wider scope if the note you need is genuinely not among them."
                                .into(),
                        ));
                        transcript.push(Message {
                            role: Role::User,
                            content,
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
                        kind: EditKind::Replace,
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
                AgentAction::AppendToNote { note_id, text } => {
                    match record_body_edit(
                        runs,
                        run_id,
                        EditKind::Append,
                        "append",
                        note_id,
                        text,
                        &mut asked,
                        &mut proposal,
                        &mut *transcript,
                    )? {
                        BodyEditOutcome::Recorded => productive = true,
                        BodyEditOutcome::Refused { fresh } => {
                            productive |= fresh;
                            continue;
                        }
                    }
                }
                AgentAction::MoveNote { note_id, folder } => {
                    match record_body_edit(
                        runs,
                        run_id,
                        EditKind::Move,
                        "move",
                        note_id,
                        folder,
                        &mut asked,
                        &mut proposal,
                        &mut *transcript,
                    )? {
                        BodyEditOutcome::Recorded => productive = true,
                        BodyEditOutcome::Refused { fresh } => {
                            productive |= fresh;
                            continue;
                        }
                    }
                }
                AgentAction::SetSetting {
                    intent_id,
                    value,
                    folder,
                } => {
                    // **Resolved against this crate's own table, never against
                    // the catalogue the client sent** (myne-md/myne#850). The
                    // first two refusals are the table's answer about the
                    // setting; the third is the client's answer about whether it
                    // can apply one. Every refusal is model-readable, because a
                    // model told only "no" retries the same setting next turn,
                    // and each is a decided answer rather than a stall, so it
                    // counts as progress and cannot burn the ceiling.
                    match super::setting::writable(&intent_id) {
                        Err(refusal) => {
                            productive = true;
                            transcript.push(tool_result(
                                super::setting::refusal_message(refusal).into(),
                                None,
                            ));
                            continue;
                        }
                        Ok(intent) if !offered.contains(&intent.id) => {
                            // The table allows it; this client did not offer it.
                            // A client that has built no catalogue lands here for
                            // every setting, which is what keeps the feature
                            // inert rather than silently proposing a change no
                            // surface can render.
                            productive = true;
                            transcript.push(tool_result(
                                "set_setting refused: that setting is not one you \
                                 were offered in this session. Use one of the \
                                 settings you were given, or finish."
                                    .into(),
                                None,
                            ));
                            continue;
                        }
                        Ok(intent) => {
                            // **An OMITTED value is refused, never read as a
                            // clear** (myne-md/myne#850 task 3). Clearing is its
                            // own verb because the two WRITE different things: a
                            // set stores a value and a clear removes the entry.
                            // So a model that meant "remove this" is told which
                            // verb to use, rather than getting a clear nobody
                            // reviewed.
                            let Some(value) = value else {
                                productive = true;
                                transcript.push(tool_result(
                                    "set_setting refused: no value was given. To \
                                     change a setting, send the value you want; to \
                                     remove it, use clear_setting."
                                        .into(),
                                    None,
                                ));
                                continue;
                            };
                            match super::setting::validate(intent, &value, folder.as_deref()) {
                                Err(err) => {
                                    productive = true;
                                    transcript.push(tool_result(
                                        super::setting::value_error_message(err).into(),
                                        None,
                                    ));
                                    continue;
                                }
                                Ok(()) => {
                                    productive = true;
                                    proposal.settings.push(ProposedSetting {
                                        intent_id: intent.id.to_string(),
                                        value: Some(value.trim().to_string()),
                                        // The sub-step rides the proposal
                                        // (myne-md/myne#850 task 4), trimmed
                                        // like the value and absent when the
                                        // value does not use one, which
                                        // `validate` has just enforced.
                                        folder: folder.as_deref().map(|f| f.trim().to_string()),
                                    });
                                    transcript.push(tool_result(
                                        "Setting change recorded. It is shown to \
                                         the user for approval. Propose another, or \
                                         finish."
                                            .into(),
                                        None,
                                    ));
                                }
                            }
                        }
                    }
                }
                AgentAction::ClearSetting { intent_id } => {
                    // The same two gates as `set_setting`, and a clear is a write
                    // too, so it is offered under exactly the same conditions: a
                    // setting the table refuses is refused here, and one this
                    // client did not offer is refused here.
                    //
                    // **Plus a third that `set_setting` does not need: the
                    // setting must HAVE an empty state.** Two targets take a
                    // required value (`PrefTarget::clearable`), so a clear of one
                    // of them has no setter to reach; without this arm the model's
                    // clear would reach the proposal, be read and approved by the
                    // user, and only then be refused at the write, which is the
                    // "offered and then refused after approval" shape the whole
                    // derivation exists to prevent (myne-md/myne#850).
                    match super::setting::writable(&intent_id) {
                        Err(refusal) => {
                            productive = true;
                            transcript.push(tool_result(
                                super::setting::refusal_message(refusal).into(),
                                None,
                            ));
                            continue;
                        }
                        Ok(intent) if !offered.contains(&intent.id) => {
                            productive = true;
                            transcript.push(tool_result(
                                "clear_setting refused: that setting is not one \
                                 you were offered in this session. Use one of the \
                                 settings you were given, or finish."
                                    .into(),
                                None,
                            ));
                            continue;
                        }
                        Ok(intent) if !intent.target.clearable() => {
                            productive = true;
                            transcript.push(tool_result(
                                "clear_setting refused: that setting always has a \
                                 value, so it can be changed but not removed. Use \
                                 set_setting with a new value, or finish."
                                    .into(),
                                None,
                            ));
                            continue;
                        }
                        Ok(intent) => {
                            productive = true;
                            proposal.settings.push(ProposedSetting {
                                intent_id: intent.id.to_string(),
                                // `None` IS the clear, and it is the reason this
                                // field is an option: an empty string is a value
                                // a folder could legitimately be compared
                                // against, so the two cannot share a spelling.
                                value: None,
                                folder: None,
                            });
                            transcript.push(tool_result(
                                "Setting removal recorded. It is shown to the user \
                                 for approval. Propose another, or finish."
                                    .into(),
                                None,
                            ));
                        }
                    }
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
                AgentAction::Remember { entry_id, text } => {
                    // **At most ONE memory write per run** (`decisions/ai/0590`,
                    // the design session's Q5 rule): the loop's own counter, so
                    // a steered run cannot flood the memory store and sync
                    // traffic is bounded by the same number. A second attempt
                    // is refused with a model-readable result.
                    if memory_writes >= 1 {
                        productive = true; // a decided refusal is still progress
                        transcript.push(tool_result(
                            "remember refused: you already wrote one memory \
                             entry this run. Finish instead."
                                .into(),
                            None,
                        ));
                        continue;
                    }
                    match deps.memory {
                        None => {
                            // No memory store: the surface is unavailable
                            // (no `ai_enabled` on this device). A refusal the
                            // model can act on, not a run failure.
                            productive = true;
                            transcript.push(tool_result(
                                "remember is unavailable: the memory surface \
                                 is not enabled. Finish instead."
                                    .into(),
                                None,
                            ));
                        }
                        Some(store) => {
                            productive = true;
                            // v1 verbs carry add/update only: a bare id with
                            // text is an overwrite of that entry (the model
                            // read its id off the memory block). Removal
                            // stays a user act in the memory UI (0590), not a
                            // model verb.
                            //
                            // Provenance, threaded not derived (myne-md/myne#709):
                            // the run's own id becomes the entry's
                            // `source_conversation` link (dash-stripped UUIDv7
                            // is 32 hex), and the folders of every note read
                            // so far ride along for the write-time exclusion
                            // check. An id the snapshot does not carry reads
                            // as the root folder, which no exclusion matches:
                            // the run could only have read it through the
                            // clamped paths, and the write check covers what
                            // is known at the write.
                            let mut source_folders: Vec<String> = Vec::new();
                            for id in read_ids.iter() {
                                let folder = deps
                                    .records
                                    .get(id)
                                    .and_then(|r| r.folder.clone())
                                    .unwrap_or_default();
                                if !source_folders.contains(&folder) {
                                    source_folders.push(folder);
                                }
                            }
                            let action = super::memory::RememberAction::Upsert {
                                entry_id: entry_id.clone(),
                                text: text.clone(),
                                source_run_hex: run_id.replace('-', ""),
                                source_folders,
                            };
                            match store.remember(action).await {
                                Ok(outcome) => {
                                    memory_writes += 1;
                                    // A held write is reported as held, not as
                                    // remembered: the entry is listed for user
                                    // review and rides no run until approved.
                                    let line = if outcome.quarantined {
                                        format!(
                                            "remember saved memory entry [{}] but it \
                                             was held for user review (it tripped \
                                             the injection scan). It will be \
                                             visible in the user's memory list \
                                             but will not be used until \
                                             approved. Finish.",
                                            outcome.entry_id
                                        )
                                    } else {
                                        format!(
                                            "remember saved memory entry [{}]. \
                                             It will be visible in the user's memory list.",
                                            outcome.entry_id
                                        )
                                    };
                                    transcript.push(tool_result(line, None));
                                }
                                Err(super::error::AgentError::MemoryScanRejected) => {
                                    // The gate refused it (schema, cap or scan):
                                    // refused at the write, never persisted,
                                    // never injected. The model learns the text
                                    // was rejected, not WHY (the scan's classes
                                    // are closed and naming them would teach a
                                    // hostile note how to slip past).
                                    transcript.push(tool_result(
                                        "remember was refused by the memory gate \
                                         (the text failed the scan or the cap). \
                                         Do not retry the same text; finish."
                                            .into(),
                                        None,
                                    ));
                                }
                                Err(super::error::AgentError::MemoryAuthorshipRefused) => {
                                    // The entry was written by the user: the
                                    // model cannot overwrite it, and the
                                    // correction stays a user act in the
                                    // Memory panel. A refusal the model can
                                    // act on (write a NEW entry instead), not
                                    // a run failure.
                                    transcript.push(tool_result(
                                        "remember was refused: that entry was \
                                         written by the user and the agent \
                                         cannot overwrite it. Write a new \
                                         entry instead, or finish."
                                            .into(),
                                        None,
                                    ));
                                }
                                Err(super::error::AgentError::MemoryExcludedSource) => {
                                    // The run distilled a note from a folder
                                    // the user has since excluded: learning it
                                    // would walk around SYNC-14. Do not retry;
                                    // finish.
                                    transcript.push(tool_result(
                                        "remember was refused: the memory was \
                                         learned from a note in a folder that \
                                         is now excluded. Do not retry the \
                                         same text; finish."
                                            .into(),
                                        None,
                                    ));
                                }
                                Err(e) => return Err(e),
                            }
                        }
                    }
                }
                AgentAction::RequestScope { folder, reason } => {
                    return Ok(LoopOutcome {
                        proposal,
                        end: LoopEnd::AwaitingScope { folder, reason },
                        iterations,
                        notes_read,
                        chars_off_device,
                        memory_writes,
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
                        memory_writes,
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
                    memory_writes,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::agent::engine::{AgentCompletion, AgentRequest, AgentRequestClass};
    use crate::plugins::agent::memory::{MemoryStore, RememberAction, RememberOutcome};
    use crate::plugins::agent::tools::SearchHit;
    use crate::plugins::memory::commands::PersonalityView;
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
        /// When set, every reply is reported as CUT OFF at the token ceiling,
        /// which is what the host does when the provider says `finish_reason:
        /// "length"`. A flag on the engine rather than per reply, because the
        /// case under test is a model that keeps answering past the ceiling.
        truncated: bool,
    }

    impl ScriptEngine {
        fn new(replies: &[&str]) -> Self {
            Self {
                replies: Mutex::new(replies.iter().rev().map(|s| s.to_string()).collect()),
                seen_classes: Mutex::new(Vec::new()),
                remote: false,
                truncated: false,
            }
        }
        fn remote(replies: &[&str]) -> Self {
            let mut e = Self::new(replies);
            e.remote = true;
            e
        }
        fn truncating(replies: &[&str]) -> Self {
            let mut e = Self::new(replies);
            e.truncated = true;
            e
        }
    }

    /// Records what each request actually carried, which `ScriptEngine` cannot:
    /// that one answers by script and drops the request on the floor, so a test
    /// about what LEAVES the device has nothing to read.
    #[derive(Default)]
    struct RecordingEngine {
        requests: Mutex<Vec<String>>,
        /// Set once the FIRST request has been recorded, so a test can make the
        /// world change between two iterations at a point it controls.
        flip_after_first: Option<std::sync::Arc<core::sync::atomic::AtomicBool>>,
    }

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl AgentEngine for RecordingEngine {
        async fn complete(
            &self,
            _class: AgentRequestClass,
            r: &AgentRequest,
        ) -> Result<AgentCompletion, AgentError> {
            let rendered: String = r
                .messages
                .iter()
                .flat_map(|m| m.content.iter())
                .map(|c| c.text().to_string())
                .collect::<Vec<_>>()
                .join("\n");
            let mut seen = self.requests.lock().unwrap();
            seen.push(rendered);
            if seen.len() == 1 {
                if let Some(flag) = self.flip_after_first.as_ref() {
                    flag.store(true, core::sync::atomic::Ordering::SeqCst);
                }
            }
            drop(seen);
            // Unparseable, so every iteration is barren and the run ends on the
            // barren counter rather than on a scripted `finish`. Three
            // iterations is exactly what this test needs and no more.
            Ok(AgentCompletion {
                reply: "not an action".to_string(),
                truncated: false,
                chars_off_device: None,
            })
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
            // Stands in for what the host does: count the note-derived text
            // that would be sent, and only when the arm that served the request
            // was the remote one.
            //
            // **The `UntrustedNote` filter mirrors `adapters.rs::note_chars`**
            // (myne-md/myne#578), and the mirroring is the point rather than an
            // implementation detail: a stand-in that counts something the host
            // does not is a second opinion, and the tests built on it would
            // then pin a number production never produces.
            let chars_off_device = self.remote.then(|| {
                r.messages
                    .iter()
                    .flat_map(|m| m.content.iter())
                    .filter(|span| matches!(span, Content::UntrustedNote(_)))
                    .map(|span| span.text().chars().count())
                    .sum::<usize>()
            });
            Ok(AgentCompletion {
                reply: self.replies.lock().unwrap().pop().unwrap_or_else(|| {
                    r#"{"action":"finish","summary":"out of script"}"#.to_string()
                }),
                truncated: self.truncated,
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

    /// Two notes in the index, for the scopes that need to stay plural.
    ///
    /// `records()` carries only `a`, and `record_excluded` treats a note the
    /// index does not carry as EXCLUDED — fail closed, which is right and is
    /// also how a "two note" scope quietly became a one-note one in the first
    /// draft of `a_multi_note_scope_opens_with_titles_and_no_bodies`.
    fn records_ab() -> BTreeMap<String, NoteRecord> {
        [("a", "A"), ("b", "B")]
            .into_iter()
            .map(|(id, title)| {
                (
                    id.to_string(),
                    NoteRecord {
                        title: Some(title.into()),
                        ..Default::default()
                    },
                )
            })
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

    /// A progress sink that drops what it is handed.
    ///
    /// Most tests here are about what the loop DOES, not about what it reports,
    /// and threading a recorder through every one of them would obscure the
    /// tests that are about the reporting. Those build their own sink; see
    /// `the_run_reports_its_cost_before_it_stops`.
    fn no_progress(_: RunProgress) {}

    fn deps<'a>(engine: &'a ScriptEngine, recs: &'a BTreeMap<String, NoteRecord>) -> LoopDeps<'a> {
        deps_with(engine, recs, &[])
    }

    /// The same, with a settings catalogue offered. `offered_settings` is the
    /// gate that keeps `set_setting` inert on a client that has built no
    /// catalogue (myne-md/myne#850), so exercising the verb needs this rather
    /// than a second copy of the literal.
    fn deps_with<'a>(
        engine: &'a ScriptEngine,
        recs: &'a BTreeMap<String, NoteRecord>,
        offered_settings: &'a [String],
    ) -> LoopDeps<'a> {
        LoopDeps {
            offered_settings,
            engine,
            reader: &Reader,
            calendar: None,
            searcher: &Searcher,
            records: recs,
            exclusions: &*NO_EXCL,
            memory: None,
            language: None,
            history: &[],
            on_progress: &no_progress,
            documents: &[],
        }
    }

    /// The `remember` verb's test double: records actions, answers ids.
    struct MemStore {
        writes: Mutex<Vec<String>>,
        entries: Mutex<Vec<crate::plugins::agent::memory::MemoryInjectionEntry>>,
    }

    impl MemStore {
        fn new() -> Self {
            Self {
                writes: Mutex::new(Vec::new()),
                entries: Mutex::new(vec![crate::plugins::agent::memory::MemoryInjectionEntry {
                    id: "0184a2b3c4d5e6f708192a3b4c5d6e7f".to_string(),
                    text: "The user prefers concise answers.".to_string(),
                    from_seed: false,
                }]),
            }
        }
    }

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl MemoryStore for MemStore {
        async fn memory_for_injection(
            &self,
        ) -> Result<Vec<crate::plugins::agent::memory::MemoryInjectionEntry>, AgentError> {
            Ok(self.entries.lock().unwrap().clone())
        }
        async fn personality_for_injection(&self) -> Result<PersonalityView, AgentError> {
            Ok(PersonalityView::default())
        }
        async fn remember(&self, action: RememberAction) -> Result<RememberOutcome, AgentError> {
            let RememberAction::Upsert {
                entry_id,
                text,
                source_run_hex: _,
                source_folders: _,
            } = action;
            let id = entry_id.unwrap_or_else(|| "minted1".to_string());
            self.writes.lock().unwrap().push(text);
            Ok(RememberOutcome {
                entry_id: id,
                quarantined: false,
            })
        }
    }

    /// A searcher that finds nothing, for the empty-result arms.
    struct NoHits;
    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl ScopeSearcher for NoHits {
        async fn search(&self, _q: &str, _l: usize) -> Result<Vec<SearchHit>, AgentError> {
            Ok(Vec::new())
        }
    }

    fn deps_no_hits<'a>(
        engine: &'a ScriptEngine,
        recs: &'a BTreeMap<String, NoteRecord>,
    ) -> LoopDeps<'a> {
        LoopDeps {
            offered_settings: &[],
            engine,
            reader: &Reader,
            calendar: None,
            searcher: &NoHits,
            records: recs,
            exclusions: &*NO_EXCL,
            memory: None,
            language: None,
            history: &[],
            on_progress: &no_progress,
            documents: &[],
        }
    }

    /// Every user turn EXCEPT the opening scope message.
    ///
    /// The transcript now starts with the seed (myne-md/myne#578), so a test
    /// about the nth TOOL RESULT has to skip it. Skipping is done here rather
    /// than by shifting every index, so a test still reads "the first tool
    /// result" and `the_opening_message_carries_the_scope` below is what pins
    /// the thing being skipped.
    fn tool_turns(transcript: &[Message]) -> Vec<&Message> {
        transcript
            .iter()
            .filter(|m| m.role == Role::User)
            .skip(1)
            .collect()
    }

    /// The trusted prose of the nth tool result, or `""`.
    ///
    /// Reads the FIRST span, which is where `tool_result` puts the host's
    /// sentence.
    fn tool_prose(transcript: &[Message], nth: usize) -> String {
        tool_turns(transcript)
            .get(nth)
            .map(|m| m.content[0].text().to_string())
            .unwrap_or_default()
    }

    /// The nth tool result's spans, tagged, so a test can assert the ORDER of
    /// provenance rather than only the text.
    fn tool_spans(transcript: &[Message], nth: usize) -> Vec<&Content> {
        tool_turns(transcript)
            .get(nth)
            .map(|m| m.content.iter().collect())
            .unwrap_or_default()
    }

    /// The opening scope message: the first user turn, always.
    fn seed(transcript: &[Message]) -> &Message {
        transcript
            .iter()
            .find(|m| m.role == Role::User)
            .expect("the run opens with the scope message")
    }

    // ---- the opening message carries the scope (myne-md/myne#578) ---------
    //
    // Two of a three-request run were spent asking the host to repeat what it
    // had already resolved: `start_run` freezes the note set before the loop is
    // driven, and `list_scope` reads that same set back. These pin that the
    // opening message answers both, and the bound on how far that goes.

    // ---- a repeat read returns a pointer, not a second body ------------

    /// **The saving is measurable in the transcript, so that is where it is
    /// asserted** (myne-md/myne#619). `build_request` re-sends the whole
    /// transcript on every iteration, so a second copy of a body rides along on
    /// every remaining one, up to the 24-iteration ceiling.
    ///
    /// Two notes in scope, because a single-note scope is opened WITH its body
    /// and the model is told not to read it, which would make the first read
    /// itself the repeat and muddy what is being measured.
    #[test]
    fn a_second_read_of_the_same_note_returns_no_body() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records_ab();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

        let bodies = t
            .iter()
            .filter(|m| {
                m.content
                    .iter()
                    .any(|c| matches!(c, Content::UntrustedNote(_)))
            })
            .filter(|m| m.content.iter().any(|c| c.text().contains("body-a")))
            .count();
        assert_eq!(
            bodies, 1,
            "the body of `a` must appear exactly once in the transcript, not twice"
        );

        let pointed = t.iter().any(|m| {
            m.content
                .iter()
                .any(|c| c.text().contains("already read that note"))
        });
        assert!(pointed, "and the repeat is answered rather than ignored");
    }

    /// **The `remember` verb, end to end** (myne-md/myne#697): one write lands,
    /// a second attempt in the same run is refused with a model-readable
    /// result, and the memory block rides the system turn.
    #[test]
    fn the_remember_verb_writes_once_and_refuses_a_second() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let store = MemStore::new();
        let engine = ScriptEngine::new(&[
            r#"{"action":"remember","text":"Prefers terse answers."}"#,
            r#"{"action":"remember","text":"Second attempt."}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records_ab();
        let mut t = Vec::new();
        let deps = LoopDeps {
            offered_settings: &[],
            engine: &engine,
            reader: &Reader,
            calendar: None,
            searcher: &Searcher,
            records: &recs,
            exclusions: &*NO_EXCL,
            memory: Some(&store),
            language: None,
            history: &[],
            on_progress: &no_progress,
            documents: &[],
        };
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps,
            &mut BTreeSet::new(),
        ))
        .unwrap();

        // One write reached the store.
        assert_eq!(store.writes.lock().unwrap().len(), 1);
        assert_eq!(store.writes.lock().unwrap()[0], "Prefers terse answers.");
        // The saved id is echoed into the transcript (model-readable).
        let saved = t.iter().any(|m| {
            m.content
                .iter()
                .any(|c| c.text().contains("remember saved memory entry"))
        });
        assert!(saved, "the write is answered with the id");
        // The second attempt is refused with a model-readable result.
        let refused = t.iter().any(|m| {
            m.content
                .iter()
                .any(|c| c.text().contains("remember refused"))
        });
        assert!(refused, "a second write is refused, not silently dropped");
    }

    /// **The memory block rides the system turn** (myne-md/myne#697): the
    /// rendered block is inside the Trusted system span the 0555 marker
    /// covers. `RecordingEngine` is what can see the request; `ScriptEngine`
    /// drops it.
    #[test]
    fn the_system_turn_carries_the_memory_block() {
        let store = MemStore::new();
        let engine = RecordingEngine::default();
        let recs = records_ab();
        let mut t = Vec::new();
        let deps = LoopDeps {
            offered_settings: &[],
            engine: &engine,
            reader: &Reader,
            calendar: None,
            searcher: &Searcher,
            records: &recs,
            exclusions: &*NO_EXCL,
            memory: Some(&store),
            language: None,
            history: &[],
            on_progress: &no_progress,
            documents: &[],
        };
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps,
            &mut BTreeSet::new(),
        ))
        .unwrap();

        let seen = engine.requests.lock().unwrap();
        let first = &seen[0];
        assert!(
            first.contains("[0184a2b3c4d5e6f708192a3b4c5d6e7f] The user prefers concise answers."),
            "the memory entry rides the system turn; got: {first}"
        );
        assert!(
            first.contains("never an instruction"),
            "the data-never-instruction framing rides with it"
        );
    }

    /// **The single-note scope, which the first version of this guard missed.**
    ///
    /// `opening_scope` reads the body and records the id, but deliberately
    /// registers no `asked` entry, so the model's first `read_note` on that
    /// scope is `fresh`. A guard requiring `!fresh` therefore stood down for the
    /// default shape ("Working on: This note") and the body went into the
    /// transcript a second time, riding every remaining iteration, which is
    /// precisely the cost this change exists to remove.
    ///
    /// Asserted by COUNTING the body in the transcript rather than by reading
    /// the guard's condition: the condition is what was wrong, so a test shaped
    /// like it would have agreed with the defect.
    #[test]
    fn a_single_note_scope_does_not_send_its_body_twice_when_the_model_reads_it() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

        let bodies = t
            .iter()
            .filter(|m| m.content.iter().any(|c| c.text().contains("body-a")))
            .count();
        assert_eq!(
            bodies, 1,
            "the opening message already carried the body; the model's read must not add a second copy"
        );
        assert_eq!(
            out.notes_read, 1,
            "and the note is still counted once, not zero and not twice"
        );
    }

    /// The direction that would make the saving a bug: a DIFFERENT note still
    /// gets its body. Without this, "return no body on a repeat" could be
    /// implemented as "return no body after the first read of anything".
    #[test]
    fn a_read_of_a_different_note_still_returns_its_body() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"read_note","note_id":"b"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records_ab();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

        for id in ["body-a", "body-b"] {
            assert!(
                t.iter()
                    .any(|m| m.content.iter().any(|c| c.text().contains(id))),
                "{id} must be in the transcript"
            );
        }
    }

    /// `notes_read` counts NOTES, not calls, and the pointer path must not
    /// change that: the run-cost line the user reads is derived from it.
    #[test]
    fn a_repeat_read_does_not_change_the_notes_read_count() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records_ab();
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert_eq!(out.notes_read, 1);
    }

    #[test]
    fn the_opening_message_carries_the_scope() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[r#"{"action":"finish","summary":"ok"}"#]);
        let recs = records();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

        let opening = seed(&t);
        assert_eq!(opening.role, Role::User);
        // Prose first, payload last, as `tool_result` requires of every result.
        assert!(matches!(opening.content[0], Content::Trusted(_)));
        assert!(opening.content[0].text().contains("scope"));
        assert!(matches!(opening.content[1], Content::UntrustedNote(_)));
    }

    #[test]
    fn a_single_note_scope_opens_with_the_note_itself() {
        // The case this is worth most for: "Working on: This note" is the
        // default, and it used to cost `list_scope` AND `read_note` before the
        // model could answer anything.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[r#"{"action":"finish","summary":"ok"}"#]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

        // `Reader` answers "body-a" for any id.
        assert_eq!(seed(&t).content[1].text(), "body-a");
        // ONE model round-trip for a question that used to take three.
        assert_eq!(out.iterations, 1);
        // And the read is reported, because the body did leave the device.
        assert_eq!(out.notes_read, 1);
    }

    #[test]
    fn a_multi_note_scope_opens_with_titles_and_no_bodies() {
        // The bound. A character-budgeted partial pre-load was rejected for
        // being the split state that confuses a small model; this asserts the
        // rule that replaced it, so widening it later is a decision rather than
        // a drift.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let engine = ScriptEngine::new(&[r#"{"action":"finish","summary":"ok"}"#]);
        let recs = records_ab();
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

        let payload = seed(&t).content[1].text();
        assert!(payload.contains('a') && payload.contains('b'), "both ids");
        assert!(!payload.contains("body-"), "and neither body");
        assert_eq!(out.notes_read, 0, "nothing was read");
    }

    #[test]
    fn an_empty_scope_opens_by_saying_so_and_sends_no_payload() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&[]));
        let engine = ScriptEngine::new(&[r#"{"action":"finish","summary":"ok"}"#]);
        let recs = records();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert_eq!(seed(&t).content.len(), 1, "no payload span at all");
        assert!(seed(&t).content[0].text().contains("empty"));
    }

    #[test]
    fn a_resumed_run_is_not_seeded_again() {
        // **The guard is `transcript.is_empty()`, and this is why.** A run
        // resumed after a scope approval arrives with a transcript; re-seeding
        // would restate a scope the model has been working in, and would state
        // the OLD one, since the widening is exactly what it just received.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[r#"{"action":"finish","summary":"ok"}"#]);
        let recs = records();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        let after_first = t.iter().filter(|m| m.role == Role::User).count();

        // The second leg, driven onto the SAME transcript, as a resume does.
        // It calls a tool rather than finishing at once, so it genuinely adds a
        // user turn and the non-vacuity check below can mean something.
        let engine2 = ScriptEngine::new(&[
            r#"{"action":"list_scope"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine2, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        let opening_messages = t
            .iter()
            .filter(|m| m.role == Role::User && m.content[0].text().contains("Your scope"))
            .count();
        assert_eq!(opening_messages, 1, "seeded once, not once per leg");
        assert!(
            t.iter().filter(|m| m.role == Role::User).count() > after_first,
            "the second leg did add turns, so this is not vacuous"
        );
    }

    // ---- every tool answer says what it answers (myne-md/myne#574) --------
    //
    // **The property is that a result is not a bare blob.** Three of the six
    // paths used to push nothing but the payload, so a run received a user turn
    // holding a note title and nothing saying it answered the call the model had
    // just made. That is not a hypothetical: a run spent four provider requests
    // calling `list_scope` four times with a perfectly good one-line answer
    // already in its context, and stalled.
    //
    // Asserted on the SPANS rather than on the concatenated text, because the
    // order carries the security half: the host's prose is `Trusted`, the
    // payload is not, and the payload goes last so note text is never the thing
    // a frame is prepended to.

    #[test]
    fn list_scope_names_itself_and_states_the_count() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"list_scope"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

        let prose = tool_prose(&t, 0);
        assert!(
            prose.contains("list_scope"),
            "the result must name its tool"
        );
        assert!(
            prose.contains('1'),
            "the count belongs in the trusted prose: a forged extra line in the \
             payload then contradicts a number the host wrote"
        );
        let spans = tool_spans(&t, 0);
        assert_eq!(spans.len(), 2, "prose, then payload");
        assert!(matches!(spans[0], Content::Trusted(_)));
        assert!(
            matches!(spans[1], Content::UntrustedNote(_)),
            "titles are note plaintext and keep the untrusted tag"
        );
        assert!(spans[1].text().contains('a'), "the id is in the payload");
    }

    #[test]
    fn an_empty_scope_says_so_and_sends_no_payload() {
        // It used to push `Content::note("")`: a user turn whose entire content
        // was the empty string, which nothing reading it can tell from a broken
        // tool.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&[]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"list_scope"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

        let spans = tool_spans(&t, 0);
        assert_eq!(spans.len(), 1, "no payload span at all, not an empty one");
        assert!(spans[0].text().contains("no notes"));
        assert!(!spans[0].text().is_empty());
    }

    #[test]
    fn read_note_names_itself_and_states_the_length() {
        // **Two notes in scope, deliberately.** A single-note scope is opened
        // WITH its body, so the id is already in `read_ids` and the model's
        // `read_note` is answered with a pointer rather than a second copy
        // (myne-md/myne#619). This test is about the FRAMING of a real read, so
        // it needs a scope where one still happens.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records_ab();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

        let spans = tool_spans(&t, 0);
        assert_eq!(spans.len(), 2);
        assert!(spans[0].text().contains("read_note"));
        // `Reader` answers "body-a", six characters.
        assert!(spans[0].text().contains('6'));
        assert!(matches!(spans[1], Content::UntrustedNote(_)));
        assert_eq!(spans[1].text(), "body-a");
    }

    #[test]
    fn search_scope_frames_its_hits_and_says_when_it_found_none() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"search_scope","query":"q"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        let prose = tool_prose(&t, 0);
        assert!(prose.contains("search_scope") && prose.contains('1'));
        // Ids are host-minted, so there is no untrusted payload here at all.
        assert_eq!(tool_spans(&t, 0).len(), 1);

        let runs2 = AgentRunState::default();
        runs2.start("r".into(), ids(&["a"]));
        let engine2 = ScriptEngine::new(&[
            r#"{"action":"search_scope","query":"q"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let mut t2 = Vec::new();
        block_on(drive(
            &runs2,
            "r",
            "task",
            &mut t2,
            &deps_no_hits(&engine2, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert!(
            tool_prose(&t2, 0).contains("found nothing"),
            "an empty search is a sentence, not an empty string"
        );
    }

    #[test]
    fn search_vault_states_its_in_scope_count() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"search_vault","query":"q"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        let prose = tool_prose(&t, 0);
        assert!(prose.contains("search_vault") && prose.contains('1'));
    }

    #[test]
    fn a_repeated_call_is_told_it_is_repeating() {
        // **The corrector the barren counter never had.** `asked` already knew
        // the call was a repeat; the loop counted it and then served the
        // identical answer in silence, so the model saw the same state it had
        // seen before and had no reason to do anything different. Three of those
        // and the run is cut off having spent three requests.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"list_scope"}"#,
            r#"{"action":"list_scope"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

        let said: Vec<String> = t
            .iter()
            .filter(|m| m.role == Role::User)
            .map(|m| m.content[0].text().to_string())
            .collect();
        assert!(
            !said[0].contains("already made that exact call"),
            "the FIRST call is not a repeat and must not be scolded"
        );
        assert!(
            said.iter()
                .any(|s| s.contains("already made that exact call")),
            "the second one is"
        );
    }

    #[test]
    #[tracing_test::traced_test]
    fn every_tool_result_says_how_big_it_was() {
        // The figure whose absence made a real run undiagnosable: "the scope was
        // empty" and "the model looped on a good answer" were indistinguishable
        // from the trail, and telling them apart took arithmetic on
        // `chars_off_device`.
        // Two notes for the same reason `read_note_names_itself_and_states_the_length`
        // needs them: a single-note scope answers `read_note` with a pointer and
        // logs no `body_chars`, so the read this asserts on would never happen.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"list_scope"}"#,
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"search_scope","query":"q"}"#,
            r#"{"action":"search_vault","query":"q"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records_ab();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

        assert!(logs_contain("event=\"tool\" verb=\"list_scope\" entries=2"));
        assert!(logs_contain(
            "event=\"tool\" verb=\"read_note\" body_chars=6"
        ));
        assert!(logs_contain("event=\"tool\" verb=\"search_scope\" hits=1"));
        assert!(logs_contain("event=\"tool\" verb=\"search_vault\" hits=1"));
    }

    #[test]
    #[tracing_test::traced_test]
    fn the_tool_trail_carries_no_title_and_no_body() {
        // The DENY list over the lines added with the framing. The sibling test
        // below covers the reply and the task; these two values only reach a log
        // line through the new `event="tool"` records, so they need their own
        // injection rather than being assumed covered.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"list_scope"}"#,
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs: BTreeMap<String, NoteRecord> = [(
            "a".to_string(),
            NoteRecord {
                title: Some("TITLEMARKER".into()),
                ..Default::default()
            },
        )]
        .into_iter()
        .collect();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

        // The title really did reach the transcript, or the assertion below
        // would pass for having tested nothing.
        assert!(
            t.iter()
                .any(|m| m.content.iter().any(|c| c.text().contains("TITLEMARKER"))),
            "the title must be in the transcript for its absence from the log to mean anything"
        );
        for marker in ["TITLEMARKER", "body-a"] {
            assert!(
                !logs_contain(marker),
                "{marker} reached a log line (DENY-list violation)"
            );
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
            &mut BTreeSet::new(),
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
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
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
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert!(out.proposal.edits.is_empty());
    }

    // ---- setting intents (myne-md/myne#850) -------------------------------

    #[test]
    fn a_setting_intent_reaches_the_proposal() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"set_setting","intent_id":"editor.weekly-notes-folder","value":"J/Weekly"}"#,
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records();
        let offered = vec!["editor.weekly-notes-folder".to_string()];
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "change my weekly notes folder",
            &mut t,
            &deps_with(&engine, &recs, &offered),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert_eq!(out.proposal.settings.len(), 1);
        assert_eq!(
            out.proposal.settings[0].intent_id,
            "editor.weekly-notes-folder"
        );
        assert_eq!(out.proposal.settings[0].value.as_deref(), Some("J/Weekly"));
    }

    /// **The gate.** The verb exists and the table accepts it, and a client that
    /// has built no catalogue still cannot get a setting into a proposal,
    /// because that proposal would have no surface to render it. This is the
    /// assertion that keeps the feature inert rather than silent.
    #[test]
    fn a_setting_intent_is_refused_when_the_client_offers_no_catalogue() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"set_setting","intent_id":"editor.weekly-notes-folder","value":"J/Weekly"}"#,
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "change my weekly notes folder",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert!(
            out.proposal.settings.is_empty(),
            "nothing may be proposed where the client cannot apply it"
        );
        // And the model is told, so it does not retry the same setting.
        assert!(t.iter().any(|m| m
            .content
            .iter()
            .any(|c| c.text().contains("not one you were offered"))));
    }

    /// A control is refused by the derivation even when a catalogue is offered,
    /// which is the loop half of the boundary the apply path also enforces.
    #[test]
    fn a_setting_intent_outside_the_table_is_refused_by_derivation() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"set_setting","intent_id":"privacy.auto-lock","value":"60"}"#,
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records();
        // Offered, so the refusal is unambiguously the TABLE's answer about the
        // setting rather than the client's answer about its catalogue.
        let offered = vec!["editor.weekly-notes-folder".to_string()];
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "turn off auto lock",
            &mut t,
            &deps_with(&engine, &recs, &offered),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert!(
            out.proposal.settings.is_empty(),
            "a control must not reach the proposal"
        );
    }

    /// An invalid value is refused before the dialog exists, so a user is never
    /// asked to approve a change that could not be stored.
    #[test]
    fn an_invalid_setting_value_is_refused_before_the_proposal() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"set_setting","intent_id":"editor.weekly-notes-folder","value":"   "}"#,
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records();
        let offered = vec!["editor.weekly-notes-folder".to_string()];
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "change my weekly notes folder",
            &mut t,
            &deps_with(&engine, &recs, &offered),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert!(out.proposal.settings.is_empty());
    }

    /// **An omitted value is refused, never read as a clear** (myne-md/myne#850
    /// task 3). Before `value` was an `Option`, a reply missing the field failed
    /// to deserialize and the action was dropped, so the model got no answer and
    /// retried; now it reaches this refusal, which names the verb it meant.
    #[test]
    fn a_setting_with_no_value_is_refused_rather_than_read_as_a_clear() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"set_setting","intent_id":"editor.weekly-notes-folder"}"#,
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records();
        let offered = vec!["editor.weekly-notes-folder".to_string()];
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "remove my weekly notes folder",
            &mut t,
            &deps_with(&engine, &recs, &offered),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert!(
            out.proposal.settings.is_empty(),
            "an omitted value must not become a clear"
        );
        assert!(t.iter().any(|m| m
            .content
            .iter()
            .any(|c| c.text().contains("use clear_setting"))));
    }

    /// The clear verb reaches the proposal as `None`, which is what tells the
    /// write path to REMOVE the entry rather than store an empty value.
    #[test]
    fn a_clear_reaches_the_proposal_with_no_value() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"clear_setting","intent_id":"editor.weekly-notes-folder"}"#,
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records();
        let offered = vec!["editor.weekly-notes-folder".to_string()];
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "remove my weekly notes folder",
            &mut t,
            &deps_with(&engine, &recs, &offered),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert_eq!(out.proposal.settings.len(), 1);
        assert_eq!(
            out.proposal.settings[0].intent_id,
            "editor.weekly-notes-folder"
        );
        assert_eq!(out.proposal.settings[0].value, None);
    }

    /// A clear is refused under the same two gates a set is, because it is a
    /// write too: a control cannot be cleared by the agent any more than it can
    /// be set.
    #[test]
    fn a_clear_of_a_control_is_refused() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"clear_setting","intent_id":"privacy.auto-lock"}"#,
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records();
        let offered = vec!["editor.weekly-notes-folder".to_string()];
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "turn off auto lock",
            &mut t,
            &deps_with(&engine, &recs, &offered),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert!(out.proposal.settings.is_empty());
    }

    /// **The clearable gate, which is the clear verb's third.** Two targets take
    /// a required value, so a clear of one has no setter to reach. Without this
    /// gate the clear reached the proposal and was refused only at the write,
    /// after the user had read and approved the row (myne-md/myne#850).
    ///
    /// The catalogue is OFFERED here on purpose: with an empty one the offered
    /// gate would refuse first and the assertion would pass for a reason that has
    /// nothing to do with clearability.
    #[test]
    fn a_clear_of_a_setting_with_no_empty_state_is_refused_before_the_proposal() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"clear_setting","intent_id":"editor.daily-notes-folder"}"#,
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records();
        let offered = vec!["editor.daily-notes-folder".to_string()];
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "remove my daily notes folder",
            &mut t,
            &deps_with(&engine, &recs, &offered),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert!(out.proposal.settings.is_empty());
        assert!(t.iter().any(|m| m
            .content
            .iter()
            .any(|c| c.text().contains("can be changed but not removed"))));
    }

    /// **The offered gate, on the clear verb.** A client that cannot write
    /// preferences offers nothing (myne-md/myne#850 task 5), so a clear arriving
    /// against an empty catalogue is refused in `myne-core` rather than accepted
    /// into a proposal whose write the ACL would refuse after approval.
    #[test]
    fn a_clear_is_refused_when_the_client_offered_nothing() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"clear_setting","intent_id":"editor.weekly-notes-folder"}"#,
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "remove my weekly notes folder",
            &mut t,
            // `deps` offers nothing, which is what a detached window sends.
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert!(out.proposal.settings.is_empty());
        assert!(t.iter().any(|m| m
            .content
            .iter()
            .any(|c| c.text().contains("clear_setting refused"))));
    }

    /// **The sub-step reaches the proposal** (myne-md/myne#850 task 4): the mode
    /// and the folder it needs are one change over two pref fields.
    #[test]
    fn a_mode_and_folder_setting_reaches_the_proposal_with_its_folder() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"set_setting","intent_id":"files.new-note-location","value":"specific","folder":"J/Weekly"}"#,
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records();
        let offered = vec!["files.new-note-location".to_string()];
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "put new notes in J/Weekly",
            &mut t,
            &deps_with(&engine, &recs, &offered),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert_eq!(out.proposal.settings.len(), 1);
        assert_eq!(out.proposal.settings[0].value.as_deref(), Some("specific"));
        assert_eq!(out.proposal.settings[0].folder.as_deref(), Some("J/Weekly"));
    }

    /// And the mode that needs a folder is refused without one, BEFORE the user
    /// is asked to approve it: `specific` alone is a state the settings panel
    /// would render as a desync.
    #[test]
    fn a_mode_that_needs_a_folder_is_refused_without_one() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"set_setting","intent_id":"files.new-note-location","value":"specific"}"#,
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records();
        let offered = vec!["files.new-note-location".to_string()];
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "put new notes somewhere",
            &mut t,
            &deps_with(&engine, &recs, &offered),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert!(out.proposal.settings.is_empty());
        assert!(t.iter().any(|m| m
            .content
            .iter()
            .any(|c| c.text().contains("needs a folder"))));
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
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
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
    fn a_mistyped_note_id_is_answered_with_the_right_one_rather_than_with_widening() {
        // myne-md/myne#559. A model that mistypes an id used to be told only
        // "use request_scope", so it asked the user to widen a scope that was
        // already correct: the scope held the note, the id did not name it. The
        // refusal now leads with the fix. With one note in scope there is no
        // ambiguity to describe, so it is named outright.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"propose_edit","note_id":"a-typo","anchor":"x","replacement":"y"}"#,
            r#"{"action":"finish","summary":"gave up"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert!(out.proposal.edits.is_empty(), "the mistyped id is refused");

        let told = t
            .iter()
            .filter(|m| m.role == Role::User)
            .flat_map(|m| m.content.iter())
            .map(|c| c.text().to_string())
            .collect::<Vec<_>>()
            .join(" ");
        // The correct id is offered…
        assert!(
            told.contains("exactly one note") && told.contains("a"),
            "the refusal must name the id the model should have used: {told}"
        );
        // …and widening is mentioned last rather than as the remedy.
        let scope_hint = told.find("wider scope").expect("widening is still offered");
        let id_hint = told.find("exactly one note").expect("the id hint is there");
        assert!(
            id_hint < scope_hint,
            "the id comes before the widening, or the model reads widening as the fix"
        );
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
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
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
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
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
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
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
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
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
            truncated: false,
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
                    truncated: false,
                    chars_off_device: None,
                })
            }
        }
        let recs = records();
        let forever = Forever {
            turn: Mutex::new(0),
        };
        let d = LoopDeps {
            offered_settings: &[],
            exclusions: &*NO_EXCL,
            memory: None,
            engine: &forever,
            reader: &Reader,
            calendar: None,
            searcher: &Searcher,
            records: &recs,
            language: None,
            history: &[],
            on_progress: &no_progress,
            documents: &[],
        };
        let mut t = Vec::new();
        let out = block_on(drive(&runs, "r", "task", &mut t, &d, &mut BTreeSet::new())).unwrap();
        assert_eq!(out.end, LoopEnd::ExhaustedIterations);
        assert_eq!(out.iterations, MAX_ITERATIONS);
        drop(engine);
    }

    // ---- the live cost report (myne-md/myne#456) -------------------------

    /// The loop discloses its cost BEFORE it stops, and the last thing it says
    /// matches what it returns.
    ///
    /// **Why the second half is the load-bearing one.** A live counter that
    /// drifts from the outcome is worse than no live counter: the surface would
    /// show one figure while the run was going and swap it for a different one
    /// the moment it stopped, and `docs/decisions/ai/0515` names the off-device
    /// figure as the compensating control for an arm with no volume bound. A
    /// control that visibly disagrees with itself is not one.
    ///
    /// Asserted on a REMOTE engine, because `chars_off_device` is `None` on the
    /// local arm and the interesting number would be absent from both sides.
    #[test]
    fn the_run_reports_its_cost_before_it_stops_and_the_last_report_matches_the_outcome() {
        use std::sync::Mutex as StdMutex;

        // Two reads then a finish: three round-trips, so a report-per-iteration
        // gives three reports and a report-at-the-end gives one.
        let engine = ScriptEngine::remote(&[
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"read_note","note_id":"b"}"#,
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records_ab();
        let seen: StdMutex<Vec<RunProgress>> = StdMutex::new(Vec::new());
        let record = |p: RunProgress| seen.lock().unwrap().push(p);
        let d = LoopDeps {
            offered_settings: &[],
            engine: &engine,
            reader: &Reader,
            calendar: None,
            searcher: &Searcher,
            records: &recs,
            exclusions: &*NO_EXCL,
            memory: None,
            language: None,
            history: &[],
            on_progress: &record,
            documents: &[],
        };
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let mut t = Vec::new();
        let out = block_on(drive(&runs, "r", "task", &mut t, &d, &mut BTreeSet::new())).unwrap();

        let reports = seen.lock().unwrap().clone();

        // ONE report per model round-trip. Not one at the end, which is the
        // behaviour this replaces.
        assert_eq!(
            reports.len(),
            out.iterations,
            "one report per round-trip: {reports:?}"
        );
        assert!(reports.len() > 1, "the fixture must run more than one round-trip, or 'before it stops' is not being tested");

        // Running totals, never deltas, and never falling. A figure that went
        // down would mean the receiver had to remember, which is exactly the
        // shape a dropped message under-reports forever after.
        for pair in reports.windows(2) {
            assert!(
                pair[1].iterations >= pair[0].iterations
                    && pair[1].notes_read >= pair[0].notes_read,
                "the totals must never fall: {pair:?}"
            );
        }
        assert_eq!(
            reports[0].iterations, 1,
            "the first report is the first round-trip"
        );

        // The last thing said while running is what the outcome says. This is
        // the assertion that stops the live figure from becoming a second,
        // drifting count of the same thing.
        let last = reports.last().copied().expect("a report");
        assert_eq!(last.iterations, out.iterations);
        assert_eq!(last.notes_read, out.notes_read);
        assert_eq!(last.chars_off_device, out.chars_off_device);

        // And it is a real number rather than an absent one, or the equality
        // above would hold for two `None`s and prove nothing about the figure
        // the disclosure control actually rests on.
        assert!(
            last.chars_off_device.is_some_and(|n| n > 0),
            "the remote arm must report text leaving the device: {last:?}"
        );
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
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

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
        // Split at `run_id`, which now sits between the event and the tag: the
        // field is what ties this line to the run the surface shows, and the tag
        // is what the test is actually about.
        assert!(logs_contain("event=\"run_stopped\""));
        assert!(logs_contain("end=\"finished\""));
        // **How long the closing summary was, never what it said**
        // (myne-md/myne#568). `"ok"` is two characters. Without this figure
        // `edits=0` is ambiguous between "the model proposed nothing" and "the
        // model was never asked to propose anything, it answered a question" —
        // which in one mode is most runs, and which took a whole session to work
        // out from the surface.
        assert!(logs_contain("summary_chars=2"));
    }

    #[test]
    #[tracing_test::traced_test]
    fn a_run_that_answered_nothing_says_zero_rather_than_omitting_the_figure() {
        // The other direction. A field that appears only when it is non-zero is
        // a field a reader cannot use to distinguish "no summary" from "this
        // build does not log it", so the absence has to be a value.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[r#"{"action":"finish","summary":""}"#]);
        let recs = records();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert!(logs_contain("summary_chars=0"));
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
            &mut BTreeSet::new(),
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
        block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert!(logs_contain("event=\"run_stopped\""));
        assert!(logs_contain("end=\"stalled\""));
        assert!(logs_contain("barren_streak=3"));
    }

    /// The failure mode the token ceiling itself introduced.
    ///
    /// A reply stopped at `AGENT_MAX_OUTPUT_TOKENS` is broken JSON, so it
    /// parses to zero actions and lands in the same arm as a model that cannot
    /// hold the format. Those are different problems and want different
    /// sentences: told "no valid action found", a model looks for a format
    /// error it did not make and answers at the same length again, so all three
    /// barren strikes go the same way and the run stalls naming the wrong
    /// cause.
    ///
    /// Asserted on the TRANSCRIPT rather than on the verdict, because the
    /// verdict is the same either way and what this fix changes is what the
    /// model was told in between.
    #[test]
    fn a_cut_off_reply_is_told_so_rather_than_told_it_broke_the_format() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        // What a reply stopped mid-token actually looks like.
        let engine = ScriptEngine::truncating(&[r#"{"action":"propose_edit","note_id":"a","anc"#]);
        let recs = records();
        let mut t = Vec::new();
        let _ = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        let said: String = t
            .iter()
            .flat_map(|m| m.content.iter())
            .map(|c| c.text().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            said.contains("cut off"),
            "the model must be told its reply was cut off: {said}"
        );
        assert!(
            !said.contains("No valid action found"),
            "and must not be told it broke the format, which it did not: {said}"
        );
    }

    /// The other direction, so the arm above cannot be satisfied by always
    /// saying "cut off". Same broken reply, provider reporting a normal stop.
    #[test]
    fn an_unparseable_reply_that_was_not_cut_off_still_gets_the_format_message() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[r#"{"action":"propose_edit","note_id":"a","anc"#]);
        let recs = records();
        let mut t = Vec::new();
        let _ = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        let said: String = t
            .iter()
            .flat_map(|m| m.content.iter())
            .map(|c| c.text().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            said.contains("No valid action found"),
            "an ordinary malformed reply keeps the format message: {said}"
        );
        assert!(
            !said.contains("cut off"),
            "and must not be told it was truncated when the provider said otherwise: {said}"
        );
    }

    /// The repeat-read pointer across a RESUMED leg, which is the case the
    /// single-leg tests cannot reach.
    ///
    /// A run paused for a scope approval comes back through `step`, which
    /// restores the transcript. The read set used to be created fresh inside the
    /// loop, so leg two believed it had read nothing while leg one's bodies were
    /// still in the transcript above it: the guard let the re-read through and
    /// pushed a second copy of a body already in the prompt, which then rode
    /// every remaining iteration. Modelled here by driving twice with the SAME
    /// transcript and the SAME set, which is exactly what `step` does.
    #[test]
    fn a_resumed_leg_does_not_re_read_a_note_the_first_leg_already_read() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let recs = records();
        let mut t = Vec::new();
        let mut read = BTreeSet::new();

        let leg1 = ScriptEngine::new(&[
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"finish","summary":"leg one"}"#,
        ]);
        let _ = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&leg1, &recs),
            &mut read,
        ))
        .unwrap();
        let after_leg1 = t.len();
        assert!(read.contains("a"), "leg one recorded the read");

        let leg2 = ScriptEngine::new(&[
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"finish","summary":"leg two"}"#,
        ]);
        let _ = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&leg2, &recs),
            &mut read,
        ))
        .unwrap();

        let prose: String = t[after_leg1..]
            .iter()
            .flat_map(|m| m.content.iter())
            .map(|c| c.text().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            prose.contains("already read that note"),
            "leg two must be pointed at the copy above it: {prose}"
        );
    }

    /// **An exclusion change DURING a run stops the seed from that iteration
    /// on**, which is SYNC-14's no-in-flight-carve-out applied to the one
    /// component that cannot be filtered.
    ///
    /// The frontend cut governs runs that have not started and the host cut
    /// governs the scope-approval pause. Neither covers a run that is executing,
    /// and that is up to 24 iterations, measured at 12m49s on a remote provider.
    /// Until this the seed was fixed for the whole of it while
    /// `docs/decisions/ai/0553` and `threat-model.md` TB13 both cited SYNC-14 as
    /// the bound.
    ///
    /// Asserted on what reaches the REQUEST, since that is the value that leaves
    /// the device.
    #[test]
    fn an_exclusion_change_mid_run_stops_the_seed_from_that_iteration_on() {
        use core::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        // The switch a USER flips, shared with the engine so the change lands
        // between two iterations rather than after a call count nobody can
        // predict: `opening_scope` asks before the loop, so a counter would
        // make this test depend on how many times the loop happens to ask.
        let excluded_yet = Arc::new(AtomicBool::new(false));

        struct ChangesMidRun(Arc<AtomicBool>);
        #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
        #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
        impl ExclusionSource for ChangesMidRun {
            async fn excluded_now(&self) -> Result<Vec<String>, AgentError> {
                Ok(if self.0.load(Ordering::SeqCst) {
                    vec!["Private/".to_string()]
                } else {
                    Vec::new()
                })
            }
        }

        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let recs = records();
        let seeded = [Message {
            role: Role::User,
            content: vec![Content::note("an earlier question about the list")],
        }];
        let engine = RecordingEngine {
            requests: Mutex::new(Vec::new()),
            // Flip the exclusion set once the first request has been recorded,
            // which is the user acting mid-run.
            flip_after_first: Some(Arc::clone(&excluded_yet)),
        };
        let excl = ChangesMidRun(Arc::clone(&excluded_yet));
        let deps = LoopDeps {
            offered_settings: &[],
            engine: &engine,
            reader: &Reader,
            calendar: None,
            searcher: &Searcher,
            records: &recs,
            exclusions: &excl,
            memory: None,
            language: None,
            history: &seeded,
            on_progress: &no_progress,
            documents: &[],
        };
        let mut t = Vec::new();
        let _ = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps,
            &mut BTreeSet::new(),
        ))
        .unwrap();

        let seen = engine.requests.lock().unwrap();
        assert!(seen.len() >= 2, "the run must reach a second iteration");
        assert!(
            seen[0].contains("an earlier question about the list"),
            "the first iteration carries the seed, or this proves nothing"
        );
        assert!(
            !seen[seen.len() - 1].contains("an earlier question about the list"),
            "after the exclusion set moved, the seed must be gone: {:?}",
            seen[seen.len() - 1]
        );
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
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
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
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
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
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
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
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
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
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut t,
            &deps(&engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
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
        let one = block_on(drive(
            &runs2,
            "r",
            "task",
            &mut t2,
            &deps(&single, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();
        assert_eq!(one.iterations, 1);
        assert!(
            total > one.chars_off_device.unwrap(),
            "a two-request run must report more than a one-request run: {total} vs {:?}",
            one.chars_off_device
        );
    }

    /// A reader whose body is LONG, for the one test that asks whether vault
    /// text moves the off-device figure.
    ///
    /// **The length is the test, not the fixture** (myne-md/myne#848). The stub
    /// reader answers six characters, and against six characters the
    /// scaffold's own prose dominates: the two arms differ by "a second body
    /// came back" versus "a listing came back", so lengthening either tool's
    /// sentence flipped the inequality and the test went red for a wording
    /// change it is not about. A body hundreds of characters long makes the
    /// surplus the thing being measured.
    /// The body's own length, named so the assertion below is a bound on the
    /// FIXTURE rather than a comparison between two scaffolds.
    const LONG_BODY_PAD: usize = 400;

    struct LongReader;
    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl NoteReader for LongReader {
        async fn read_body(&self, id: &str) -> Result<String, AgentError> {
            Ok(format!("body-{id}-{}", "x".repeat(LONG_BODY_PAD)))
        }
    }

    fn deps_with_long_body<'a>(
        engine: &'a ScriptEngine,
        recs: &'a BTreeMap<String, NoteRecord>,
    ) -> LoopDeps<'a> {
        LoopDeps {
            offered_settings: &[],
            reader: &LongReader,
            ..deps(engine, recs)
        }
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
            &deps_with_long_body(&read_engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

        // **The control asks for nothing**, and that is what makes the
        // assertion a bound rather than a coincidence (myne-md/myne#848). It
        // used to call `list_scope`, so the two arms differed by "a second body
        // came back" versus "a listing came back", words against words, with
        // the scaffolds in the same order of magnitude, and lengthening the
        // listing's own prose by one character flipped the inequality. A
        // finish-only run sends one request and returns no note text at all, so
        // the read run's surplus is at least the body it re-sent, and any
        // wording change anywhere leaves that bound untouched.
        let mut without = Vec::new();
        let runs2 = AgentRunState::default();
        runs2.start("r".into(), ids(&["a"]));
        let bare_engine = ScriptEngine::remote(&[r#"{"action":"finish","summary":"ok"}"#]);
        let bare = block_on(drive(
            &runs2,
            "r",
            "task",
            &mut without,
            &deps_with_long_body(&bare_engine, &recs),
            &mut BTreeSet::new(),
        ))
        .unwrap();

        let read_chars = read
            .chars_off_device
            .expect("a remote run must report a figure, not None");
        assert!(
            read_chars >= bare.chars_off_device.unwrap() + LONG_BODY_PAD,
            "reading a note has to move the figure by at least the note's own \
             length: {read_chars} vs {:?}",
            bare.chars_off_device
        );
    }
}
