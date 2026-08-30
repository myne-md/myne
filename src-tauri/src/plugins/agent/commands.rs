// SPDX-License-Identifier: AGPL-3.0
//! The agent plugin's IPC surface.
//!
//! Eight commands, and every one of them is thin: it resolves state, calls into
//! `myne-core`'s agent plugin, and returns. No policy lives here.
//!
//! **What the payload may and may not carry**, because the sentence that used
//! to stand here said "none of these commands accepts a scope … from its
//! payload" and three of them take a `grant: ScopeGrant` (myne-md/myne#531
//! review round five). What the payload carries is the user's REQUEST — which
//! notes or which folder they picked in the approval dialog — and a request is
//! not a permission. Every grant is resolved host-side against the vault index
//! and the current `ai_excluded_folders`, refused when it canonicalizes to the
//! vault root, and refused again when the clamp empties it; the frozen set the
//! run may read is the host's answer, never the caller's list. What no command
//! accepts is the thing that would make the caller the authority: an
//! excluded-folder list, a request class, or an already-resolved note set. That
//! is the rule `decisions/ai/0462` states as "'the caller behaved' is not a
//! property of a seam".
//!
//! The **transcript** is the one piece of session state that lives here rather
//! than in core: core's run holds the approved scope and the cancel flag, which
//! are what every other module needs, and a growing message list is a host
//! session concern. Both are dropped by the same lock teardown.

use myne_core::host::tauri_host::TauriHost;
use myne_core::plugins::agent::apply::{ApplyOutcome, Approval, RefusedEdit};
use myne_core::plugins::agent::engine::{Content, Message};
use myne_core::plugins::agent::error::{AgentError, EditRejection};
use myne_core::plugins::agent::history::{seed_messages, HistoryTurn, DEFAULT_HISTORY_BUDGET};
use myne_core::plugins::agent::probe::{run_probe, ProbeProgress, ProbeThreshold, ProbeVerdict};
use myne_core::plugins::agent::prompt::{Proposal, ProposedNote};
use myne_core::plugins::agent::run::{AgentRunState, AgentRunView, AppliedRun, GrantOrigin};
use myne_core::plugins::agent::run_loop::{drive, LoopDeps, LoopEnd, LoopOutcome};
use myne_core::plugins::agent::scope::{
    expand_run, preview_grant, start_run, ExclusionSource, ScopeGrant, ScopeSource,
};
use myne_core::plugins::agent::{apply_approved, edit::ProposedEdit};
use myne_core::plugins::prefs::commands::prefs_read_from_host;
use myne_core::plugins::snapshots::commands::snapshot_restore_from_host;
use myne_core::plugins::vault_indices::state::NoteRecord;
use myne_core::plugins::vault_indices::VaultIndicesState;
use myne_core::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use myne_core::vault_io::StdVaultIo;
use protocol::PrefsView;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};
use zeroize::Zeroize;

use super::adapters::{
    EngineAdapter, NoteReadAdapter, RestoreAdapter, SearchAdapter, WriteAdapter,
};
use crate::plugins::local_inference::state::LocalInferenceState;
use crate::plugins::local_inference::vector_store::LocalInferenceVectorState;

/// The probe's pass bar, from the file that records it.
///
/// `include_str!` rather than a literal so there is exactly one place the
/// numbers live, and that place can carry the measurements that produced them.
/// The file currently declares itself unmeasured; see
/// `scripts/agent-probe-threshold.json`.
const PROBE_THRESHOLD_JSON: &str = include_str!("../../../../scripts/agent-probe-threshold.json");

#[derive(serde::Deserialize)]
struct RawThreshold {
    attempts: u8,
    required: u8,
    status: String,
    measurements: Vec<serde_json::Value>,
}

/// The bar a backend must clear, or a stated reason it could not be read.
///
/// **Returns `Result` rather than panicking, and the reason is where this is
/// called from.** [`agent_capability`] is a `#[tauri::command]`, so an
/// `.expect()` or a failed `assert_eq!` in here unwinds across the IPC
/// boundary. Tauri catches that and answers the caller with an opaque
/// serialization failure, which tells the user nothing and, on a panic that
/// happens while a lock is held, poisons it for the rest of the session. The
/// input is compiled in, so today it cannot fail; a panic reachable from IPC is
/// one edit away from being a runtime one, and this shape does not have that
/// edge. Found in review round five of myne-md/myne#531.
///
/// The strictness itself is not relaxed: [`tests::the_compiled_in_threshold_file_is_well_formed`]
/// asserts the real file parses AND that its two halves agree, so a malformed
/// or self-contradicting record is a failing `cargo test` on every platform
/// rather than a surprise at the first press of the button.
fn parse_probe_threshold(json: &str) -> Result<ProbeThreshold, String> {
    let raw: RawThreshold = serde_json::from_str(json)
        .map_err(|_| "agent-probe-threshold.json is malformed".to_string())?;
    // **The `status` field has to mean something, or it is decoration.** It
    // declared itself a blocking obligation and gated nothing: this function
    // read `attempts` and `required` and never looked at it, so flipping it to
    // `measured` with an empty `measurements` would have changed no behaviour
    // and no check.
    let measured = raw.status == "measured";
    let has_measurements = !raw.measurements.is_empty();
    if measured != has_measurements {
        return Err(format!(
            "agent-probe-threshold.json: status is {:?} but measurements has {} entries. \
             The two must agree: `measured` with no measurements is a claim nobody made, \
             and `unmeasured` with measurements is a record that has stopped describing itself.",
            raw.status,
            raw.measurements.len(),
        ));
    }
    Ok(ProbeThreshold {
        attempts: raw.attempts,
        required: raw.required,
        provisional: !measured,
    })
}

/// The threshold the probe runs against.
///
/// Falls back FAIL-CLOSED when the record cannot be read: a bar no backend
/// clears, marked provisional, so agent mode reports itself unavailable rather
/// than available on an unverified backend. The opposite default would let a
/// broken record switch the gate off.
fn probe_threshold() -> ProbeThreshold {
    parse_probe_threshold(PROBE_THRESHOLD_JSON).unwrap_or_else(|reason| {
        tracing::error!(event = "agent_probe_threshold_unreadable", %reason);
        ProbeThreshold {
            attempts: 1,
            required: u8::MAX,
            provisional: true,
        }
    })
}

/// Host-side session state for a run: what the user asked, the running
/// transcript, and what has been proposed so far.
#[derive(Default)]
struct Session {
    task: String,
    /// The user's interface language, as the WebView reported it at start.
    ///
    /// Held on the session rather than passed per step, because a run resumed
    /// after a scope approval goes through the same `step` and would otherwise
    /// lose the instruction halfway through: the model would answer the first
    /// half of a run in the user's language and the second half in English.
    /// `prompt::system_instructions` shape-checks it; nothing here trusts it.
    language: Option<String>,
    /// The visible chat history this run was seeded with, already budgeted.
    ///
    /// Held rather than re-derived per step for the reason `language` is: a run
    /// resumed after a scope approval goes through the same `step`, and losing
    /// the seed halfway through would leave the model answering the second half
    /// of a conversation it can no longer see the first half of.
    history: Vec<Message>,
    /// The egress controls as they stood when this run's seed was built.
    ///
    /// **Why a snapshot and not a re-read alone.** SYNC-14 carries no in-flight
    /// carve-out: an exclusion added while a run is open takes effect at once,
    /// which is why `apply.rs` re-reads it at the write and the read tools
    /// re-ask on every call. The seed is the one thing that cannot be re-asked,
    /// because a turn carries text and no note provenance, so there is nothing
    /// to filter. What can be done is notice that the answer changed and drop
    /// the seed, which is the same cut the WebView makes for LATER runs
    /// (`chatStore::blockSeedingOfExistingTurns`). Without this the frontend's
    /// cut covered future runs only, while a run PAUSED for a scope approval
    /// went on re-sending the pre-change conversation on every remaining leg,
    /// and `docs/decisions/ai/0541` cited SYNC-14 for a bound half of which did
    /// not exist.
    ///
    /// The provider is in the snapshot for the reason `lib/prefs.ts` gives for
    /// cutting on a provider change at all: a conversation held under one
    /// recipient is not consented to a different one.
    seed_context: SeedContext,
    /// Which notes this run has already read, across every leg.
    ///
    /// Held here rather than re-created per `step` for the reason the transcript
    /// is held: a run resumed after a scope approval re-enters the loop, and the
    /// transcript comes back with leg one's note bodies still in it. A fresh set
    /// would tell leg two it had read nothing, so the repeat-read pointer
    /// (myne-md/myne#619) would let a re-read through and push a second copy of
    /// a body already sitting above it, which then rides every remaining
    /// iteration up to the 24-iteration ceiling. A multi-leg run has the longest
    /// transcript there is, which is exactly where that costs most.
    read_ids: std::collections::BTreeSet<String>,
    transcript: Vec<Message>,
    proposal: Proposal,
    /// Whether a `step` is inside its model call for this run.
    ///
    /// `step` takes the transcript and the proposal with `mem::take` under a
    /// scoped lock, releases it for the length of a model call, then writes both
    /// back. Two concurrent calls on one run id therefore raced: the second
    /// found the transcript already taken and drove from an empty one, and
    /// whichever returned last overwrote the other's work, silently discarding a
    /// transcript and a proposal. Not reachable from the shipped single-dialog
    /// surface, and `agent_approve_scope` takes its `run_id` from the payload,
    /// so reachability is a property of the caller rather than of this code
    /// (myne-md/myne#531 review round six).
    in_flight: bool,
}

/// The table of live sessions. Cleared by the same lock teardown that clears
/// core's run table.
#[derive(Default)]
pub struct AgentSessionState {
    sessions: Mutex<BTreeMap<String, Session>>,
}

impl AgentSessionState {
    /// Which of the approved EDITS the host recorded the model proposing.
    ///
    /// **The other half of the rule its sibling below states about itself.**
    /// `read_approved_new_notes` resolves new notes by index into the host's own
    /// record, so "the caller cannot invent a note the model never proposed"
    /// holds for creates. The edits arrived as free `note_id`/`anchor`/
    /// `replacement` strings and were never compared to anything, so the same
    /// sentence was true of one half of the apply and false of the other
    /// (myne-md/myne#531 review round six).
    ///
    /// Returns the recognised edits and, separately, the positions of the ones
    /// that were not, so the caller can report them as refusals rather than drop
    /// them silently: a row the user pressed Apply on that quietly does nothing
    /// is the failure mode the whole review surface exists to avoid.
    ///
    /// Compared by VALUE, not by index. The screen may send any subset in any
    /// order, and an index-based contract would mean changing what the WebView
    /// sends, the store, the review screen and its E2E for a property this
    /// buys outright.
    ///
    /// A session that is gone recognises nothing, which fails closed: the run is
    /// over, and an apply against a record the host no longer holds is exactly
    /// the case this refuses.
    pub fn retain_proposed_edits(
        &self,
        run_id: &str,
        approved: &[ProposedEdit],
    ) -> (Vec<ProposedEdit>, Vec<usize>) {
        let table = self.sessions.lock().expect("agent session table poisoned");
        let proposed: &[ProposedEdit] = match table.get(run_id) {
            Some(session) => &session.proposal.edits,
            None => &[],
        };
        let mut kept = Vec::with_capacity(approved.len());
        let mut unknown = Vec::new();
        for (index, edit) in approved.iter().enumerate() {
            if proposed.contains(edit) {
                kept.push(edit.clone());
            } else {
                unknown.push(index);
            }
        }
        (kept, unknown)
    }

    /// The new notes the user approved, resolved against the run's own record.
    ///
    /// Two separate properties, and an earlier version conflated them. **Which
    /// notes exist** is host-side: the caller names indices into the proposal the
    /// host itself recorded, so it cannot invent a note the model never proposed.
    /// **Which of those to create** is the user's, expressed as that index list,
    /// because a create is a write and SYNC-17's restatement says no write
    /// happens without a per-note approval. Handing the whole recorded list to
    /// the apply satisfied the first and skipped the second.
    ///
    /// Out-of-range indices are dropped rather than erroring: they can only come
    /// from a stale screen, and refusing the whole apply over one is worse than
    /// applying the rest.
    ///
    /// **Reads without consuming.** The consuming version of this ran BEFORE
    /// `apply_approved`, which can still fail from three places (an out-of-scope
    /// run, a refused restore point, a failed batch write), and on any of them
    /// the notes were gone from the record and had never been created. The
    /// screen went on rendering them, so a retry sent the same indices, found a
    /// shorter list, and silently created nothing: a write the user approved
    /// that does not happen, reported only as the original failure. `apply.rs`
    /// took care not to let a failed create discard the outcome; this was the
    /// mirror hole one layer up.
    ///
    /// Consumption is now keyed off what was ACTUALLY created, by
    /// [`Self::consume_created_new_notes`], so the two cannot disagree.
    pub fn read_approved_new_notes(
        &self,
        run_id: &str,
        approved: &[usize],
    ) -> Vec<(usize, ProposedNote)> {
        let table = self.sessions.lock().expect("agent session table poisoned");
        let Some(session) = table.get(run_id) else {
            return Vec::new();
        };
        let mut wanted: Vec<usize> = approved.to_vec();
        wanted.sort_unstable();
        wanted.dedup();
        wanted
            .into_iter()
            .filter_map(|index| {
                session
                    .proposal
                    .new_notes
                    .get(index)
                    .map(|note| (index, note.clone()))
            })
            .collect()
    }

    /// Drop the notes an apply actually created, so a retry cannot create them
    /// twice and a FAILED apply leaves everything retryable.
    ///
    /// Takes the indices the apply reported as created rather than the ones it
    /// was asked to create, which is the whole point: those two lists differ
    /// exactly when something went wrong, and that is the case the previous
    /// design got backwards.
    pub fn consume_created_new_notes(&self, run_id: &str, created: &[usize]) {
        let mut table = self.sessions.lock().expect("agent session table poisoned");
        let Some(session) = table.get_mut(run_id) else {
            return;
        };
        let mut wanted: Vec<usize> = created.to_vec();
        wanted.sort_unstable();
        wanted.dedup();
        // Highest index first so each removal leaves the lower ones in place.
        for index in wanted.iter().rev() {
            if *index < session.proposal.new_notes.len() {
                let mut note = session.proposal.new_notes.remove(*index);
                // The body came out of the model and quotes note text; overwrite
                // rather than free, on the same rule as the teardown below.
                note.title.zeroize();
                note.body.zeroize();
                // And the folder, for the reason the teardown below already
                // states about itself: it is `Option<String>` rather than
                // `String`, so it is not the shape the eye checks for, and it
                // was missed here for exactly that reason a second time
                // (myne-md/myne#531 review round six). `ProposedNote` derives no
                // `ZeroizeOnDrop`, so nothing catches it if this line goes.
                if let Some(folder) = note.folder.as_mut() {
                    folder.zeroize();
                }
            }
        }
    }

    /// Wipe and drop every session. The vault-lock teardown path.
    ///
    /// **Overwrites before dropping**, which is the difference between this and
    /// a plain `clear()`. A transcript holds whole note bodies and a proposal
    /// holds the anchors copied out of them; dropping frees that memory without
    /// touching it, and `threat-model.md` §7 requires the AI path's RAM to be
    /// `Zeroizing`-scoped. The sibling teardown this rides alongside (the AI
    /// vector store) overwrites in place for the same reason.
    pub fn clear(&self) {
        let mut table = self.sessions.lock().expect("agent session table poisoned");
        for session in table.values_mut() {
            wipe_session(session);
        }
        table.clear();
    }

    /// Drop every session whose run the core table no longer holds, wiping it
    /// first.
    ///
    /// **The bound this table was missing.** `AgentRunState` caps at
    /// `MAX_LIVE_RUNS` and evicts the oldest, and nothing removed the evicted
    /// run's SESSION: after nine ordinary runs, run one's task string, its
    /// transcript of whole note bodies and its proposal of anchors copied
    /// verbatim out of them stayed resident and unreachable until the vault
    /// locked. The cap bounded a set of note ids and left the plaintext holder
    /// unbounded (myne-md/myne#531 review round six).
    ///
    /// It could not be fixed where the eviction is: that lives in `myne-core`
    /// and this table lives in the desktop crate, which is why core grew
    /// `live_ids()` and this prunes to it rather than being told what was
    /// dropped. Called at the start of a run, which is the only moment a run can
    /// be evicted.
    ///
    /// Wipes through the same `wipe_session` the lock teardown uses, so the two
    /// cannot report different notions of "gone".
    pub fn prune_to(&self, live: &std::collections::BTreeSet<String>) {
        let mut table = self.sessions.lock().expect("agent session table poisoned");
        let dead: Vec<String> = table
            .keys()
            .filter(|id| !live.contains(*id))
            .cloned()
            .collect();
        for id in dead {
            if let Some(mut session) = table.remove(&id) {
                wipe_session(&mut session);
            }
        }
    }

    /// How many sessions are live.
    ///
    /// Exists for the teardown assertion and nothing else: the test that proves
    /// a lock leaves no transcript behind has to read the state rather than a
    /// return value, because `clear` could report success while a session sat in
    /// the table. `allow(dead_code)` because production has no reason to count
    /// them, and removing them would remove the only way to check the claim.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.sessions
            .lock()
            .expect("agent session table poisoned")
            .len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Overwrite everything a session holds, before it is dropped.
///
/// **Overwrites before dropping**, which is the difference between this and a
/// plain `clear()`. A transcript holds whole note bodies and a proposal holds
/// the anchors copied out of them; dropping frees that memory without touching
/// it, and `threat-model.md` §7 requires the AI path's RAM to be
/// `Zeroizing`-scoped. One function rather than two copies, so the lock teardown
/// and the eviction prune cannot drift into different notions of total.
fn wipe_session(session: &mut Session) {
    session.task.zeroize();
    // Overwrite before dropping, and cover BOTH arms so the teardown
    // is total by construction rather than by whichever arm currently
    // holds the sensitive half. `UntrustedNote` wipes through
    // `Zeroizing` on drop; `Trusted` is a plain `String` with no such
    // drop, so a bare `.clear()` freed it untouched.
    //
    // What each arm holds today, since that is what a later reader
    // would use to decide whether this loop can go: the model's reply
    // is `Content::note` (`run_loop::drive`, tagged untrusted in this
    // same change because an anchor is note text copied verbatim), and
    // the `Trusted` spans are the host's own refusal prose. The point
    // is that the answer moves, and a teardown keyed to today's answer
    // is one tagging change away from being partial again.
    for message in &mut session.transcript {
        for span in &mut message.content {
            if let Content::Trusted(t) = span {
                t.zeroize();
            }
        }
    }
    session.transcript.clear();
    // The seeded history, and the SAME loop rather than a bare `clear()`. It
    // holds the visible chat text, it survives a leg (`step` writes the
    // transcript back, but the history lives on the session), so skipping it
    // would leave the conversation resident for the process lifetime. Today
    // `seed_messages` emits `Content::note` exclusively, so `Zeroizing` would
    // cover it and a `clear()` would be enough. That is exactly the reasoning
    // the transcript block above rejects for itself: the answer moves, and a
    // teardown keyed to today's answer is one tagging change away from being
    // partial again. A host-written header span in a future seed would be
    // `Trusted`, and this loop already covers it.
    for message in &mut session.history {
        for span in &mut message.content {
            if let Content::Trusted(t) = span {
                t.zeroize();
            }
        }
    }
    session.history.clear();
    // Note ids rather than bodies, so this is structure rather than plaintext,
    // but it is still vault structure the model produced a run against and it
    // costs one line to include.
    session.read_ids.clear();
    for edit in &mut session.proposal.edits {
        edit.anchor.zeroize();
        edit.replacement.zeroize();
    }
    for note in &mut session.proposal.new_notes {
        note.title.zeroize();
        note.body.zeroize();
        // The folder too. It is `Option<String>` rather than `String`,
        // which is the whole reason it was missed: the two lines above
        // are the shape the eye checks for. A proposed folder is a
        // vault-structure string the model produced from note content,
        // so it belongs with them.
        if let Some(folder) = note.folder.as_mut() {
            folder.zeroize();
        }
    }
    session.proposal.summary.zeroize();
}

/// What a grant would resolve to. Every number here is the host's.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantPreview {
    /// How many notes the grant would add, already clamped.
    pub note_count: usize,
    /// How many the `ai_excluded_folders` clamp removed.
    pub excluded_count: usize,
    /// How many named ids the index does not know. Non-zero only for a note
    /// list; they fail closed and are dropped.
    pub unknown_count: usize,
    /// What the run's total scope would become. A union, not a sum.
    pub new_total: usize,
}

/// What a start or a resume produced.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStepResult {
    /// The run.
    pub view: AgentRunView,
    /// Everything proposed so far.
    pub proposal: Proposal,
    /// Why the loop stopped.
    pub end: LoopEnd,
    /// How many model round-trips THIS STEP made.
    ///
    /// Per-step rather than per-run, like `chars_off_device` three lines down and
    /// for the same reason: `drive()` starts its counter at zero on every call,
    /// and the surface accumulates. The comment used to say "in total", which is
    /// a different contract than the value carries; nothing user-visible was
    /// wrong (`src/notes/agent/agentStore.ts` accumulates correctly), but a later
    /// reader hanging a cap or a warning off this field would have read it as a
    /// run total.
    pub iterations: usize,
    /// How many notes it has read in full.
    pub notes_read: usize,
    /// Characters that left the device for this step's requests, or `None` when
    /// none did.
    ///
    /// Per-step rather than per-run, because the surface accumulates it exactly
    /// as it accumulates `iterations` and `notes_read`. `None` and `Some(0)`
    /// stay distinguishable across IPC for the reason
    /// [`myne_core::plugins::agent::engine::AgentCompletion::chars_off_device`]
    /// gives.
    pub chars_off_device: Option<usize>,
    /// How many notes the `ai_excluded_folders` clamp removed from the grant
    /// that produced this step. Shown on the approval screen.
    pub excluded_count: usize,
}

/// Refuse unless AI is switched on, read from the vault's own prefs.
///
/// The WebView hiding the tab is not a gate: `src-tauri/CLAUDE.md` treats the
/// ACL surface as reachable by a compromised or dev-tools-driven page (TB6), and
/// every sibling generation surface re-reads this host-side before touching a
/// model. Without it, agent mode is the one AI surface whose opt-in lives only
/// in the page that the opt-in is supposed to constrain.
/// The chat-history seed budget a prefs view carries.
///
/// Read at START rather than held as a constant, so a change in Settings takes
/// effect on the next run rather than on the next launch.
///
/// Takes the view rather than reading one, because the caller has already paid
/// for it: `require_ai_enabled` decrypts `vault.prefs` to check the gate, and a
/// second read here meant two file reads, two subkey derivations and two AEAD
/// decrypts back to back, with nothing in between that could change the blob.
///
/// The value on disk is already clamped by the setter; this does not re-clamp,
/// because a second clamp would read as the control and hide the day the real
/// one stopped working.
/// The egress controls a seeded conversation was built under.
#[derive(Default, Clone, PartialEq, Eq)]
struct SeedContext {
    excluded_folders: Vec<String>,
    provider: Option<String>,
}

impl SeedContext {
    fn of(view: &PrefsView) -> Self {
        Self {
            excluded_folders: view.ai_excluded_folders.clone(),
            provider: view.ai_provider.clone(),
        }
    }
}

/// Drop a run's seeded conversation when the egress controls moved under it.
///
/// Called from the resume path, which already reads `vault.prefs` for the AI
/// gate, so this costs no second decrypt: the comment on [`history_budget`]
/// records why a second read there would be the wrong trade.
///
/// A drop rather than a filter, and the transcript is deliberately untouched.
/// The seed is prose with no note provenance, so nothing can be selected out of
/// it; the transcript is this run's own reads, which the tools already clamp
/// against the live exclusion set on every call.
fn cut_seed_if_context_changed(sessions: &AgentSessionState, run_id: &str, view: &PrefsView) {
    let now = SeedContext::of(view);
    let mut table = sessions
        .sessions
        .lock()
        .expect("agent session table poisoned");
    let Some(session) = table.get_mut(run_id) else {
        return;
    };
    if session.seed_context == now {
        return;
    }
    // Overwrite before dropping, the same rule and the same reason as
    // `wipe_session`: `UntrustedNote` wipes through `Zeroizing`, `Trusted` is a
    // plain `String` that a bare `clear()` would free untouched.
    for message in &mut session.history {
        for span in &mut message.content {
            if let Content::Trusted(t) = span {
                t.zeroize();
            }
        }
    }
    session.history.clear();
    session.seed_context = now;
}

fn history_budget(view: &PrefsView) -> usize {
    view.chat_history_budget
        .map(|b| b as usize)
        .unwrap_or(DEFAULT_HISTORY_BUDGET)
}

async fn require_ai_enabled<R: Runtime>(
    app: &AppHandle<R>,
    vault: &VaultRuntimeState,
) -> Result<PrefsView, AgentError> {
    let host = TauriHost::new(app.clone());
    let view = prefs_read_from_host(&host, vault, &StdVaultIo)
        .await
        .map_err(|_| AgentError::ReadFailed)?;
    if view.ai_enabled {
        // Returned rather than dropped: reading `vault.prefs` costs a file read,
        // a subkey derivation and an AEAD decrypt, and the caller needs another
        // field off the same view. Handing it back is what keeps that one read.
        Ok(view)
    } else {
        Err(AgentError::AiDisabled)
    }
}

/// Refuse unless the vault is unlocked.
///
/// **Seven of the eight commands call this FIRST**, and the eighth is
/// `agent_cancel`. Borrowing `State<'_, VaultRuntimeState>` does not gate
/// anything, so without this the locked-vault refusal was an accident of which
/// helper ran first and reported the wrong cause.
///
/// `agent_cancel` deliberately does not call it: it touches only the run table,
/// and a run that survived into a locked vault is a bug the teardown covers,
/// not something to refuse here. (This doc said "the five commands" and named
/// `agent_status` as the second abstainer; that command was removed in review
/// round two and the count was never true — `mod.rs` has the roster. Found in
/// review round five of myne-md/myne#531.)
async fn require_unlocked(vault: &VaultRuntimeState) -> Result<(), AgentError> {
    match vault.slot_kind_active().await {
        SlotKind::Unlocked => Ok(()),
        _ => Err(AgentError::SlotNotUnlocked),
    }
}

/// The desktop's answer to core's scope questions.
///
/// One implementation for all three entry points. Core owns the ORDER (refuse a
/// root grant, read the exclusions, snapshot the index, resolve, refuse an empty
/// result); this only says where the two inputs come from. That split is what
/// lets the mobile port supply an implementation rather than re-derive a
/// sequence, and it is why a client cannot supply an index snapshot without also
/// supplying the exclusions.
struct DesktopScopeSource<'a, R: Runtime> {
    app: AppHandle<R>,
    vault: &'a VaultRuntimeState,
    indices: &'a VaultIndicesState,
}

#[async_trait::async_trait]
impl<R: Runtime> ScopeSource for DesktopScopeSource<'_, R> {
    async fn records(&self) -> Result<BTreeMap<String, NoteRecord>, AgentError> {
        Ok(self.indices.snapshot())
    }

    async fn excluded_folders(&self) -> Result<Vec<String>, AgentError> {
        read_excluded(&self.app, self.vault).await
    }
}

/// The `ai_excluded_folders` set, from `vault.prefs`, at this moment.
///
/// One reader for both seams. `ScopeSource` uses it when a grant is resolved and
/// `ExclusionSource` uses it on every read tool inside the loop, and a second copy
/// of this three-line body is how the two would eventually disagree about where
/// the set comes from.
async fn read_excluded<R: Runtime>(
    app: &AppHandle<R>,
    vault: &VaultRuntimeState,
) -> Result<Vec<String>, AgentError> {
    let host = TauriHost::new(app.clone());
    let view = prefs_read_from_host(&host, vault, &StdVaultIo)
        .await
        .map_err(|_| AgentError::ReadFailed)?;
    Ok(view.ai_excluded_folders)
}

/// The loop's half of the seam: the exclusion set and nothing else.
///
/// Deliberately NOT `DesktopScopeSource`, which also answers `records()`. The
/// loop must not re-read the index (`LoopDeps::records` says why), so it is handed
/// a source that cannot.
struct DesktopExclusions<'a, R: Runtime> {
    app: AppHandle<R>,
    vault: &'a VaultRuntimeState,
}

#[async_trait::async_trait]
impl<R: Runtime> ExclusionSource for DesktopExclusions<'_, R> {
    async fn excluded_now(&self) -> Result<Vec<String>, AgentError> {
        read_excluded(&self.app, self.vault).await
    }
}

#[allow(clippy::too_many_arguments)]
async fn step<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    runs: Arc<AgentRunState>,
    sessions: &AgentSessionState,
    indices: &VaultIndicesState,
    vault: &VaultRuntimeState,
    ai: &LocalInferenceState,
    vectors: &LocalInferenceVectorState,
    cancel: Arc<AtomicBool>,
    excluded_count: usize,
) -> Result<AgentStepResult, AgentError> {
    // Claimed under the SAME lock the take happens under, so there is no window
    // between deciding to proceed and emptying the session. Released in the
    // write-back below, on every exit from this function.
    let (task, language, history, mut read_ids, mut transcript, mut proposal) = {
        let mut table = sessions
            .sessions
            .lock()
            .expect("agent session table poisoned");
        let s = table.get_mut(&run_id).ok_or(AgentError::NoSuchRun)?;
        if s.in_flight {
            return Err(AgentError::StepAlreadyRunning);
        }
        s.in_flight = true;
        (
            s.task.clone(),
            s.language.clone(),
            s.history.clone(),
            std::mem::take(&mut s.read_ids),
            std::mem::take(&mut s.transcript),
            std::mem::take(&mut s.proposal),
        )
    };

    let engine = EngineAdapter { state: ai, cancel };
    let reader = NoteReadAdapter {
        host: TauriHost::new(app.clone()),
        state: vault,
    };
    let searcher = SearchAdapter { state: ai, vectors };
    let records = indices.snapshot();
    let exclusions = DesktopExclusions {
        app: app.clone(),
        vault,
    };
    let deps = LoopDeps {
        engine: &engine,
        reader: &reader,
        searcher: &searcher,
        records: &records,
        exclusions: &exclusions,
        language: language.as_deref(),
        history: &history,
    };

    // **Not `?`.** The transcript and the proposal were taken out of the session
    // above, so propagating here drops both while the run stays in the table.
    // `EngineAdapter::complete` returns `Cancelled` when the run's flag is set
    // before or after the model call, so pressing Stop during generation, which
    // is the long part of an iteration and therefore the usual moment, threw
    // away everything the run had proposed. The loop's OWN cancel checks
    // deliberately return `Ok(LoopEnd::Cancelled)` with the proposal intact, and
    // the surface has a `cancelled` status for exactly that: the two routes
    // disagreed and the reachable one was the lossy one. Any transient engine
    // error had the same effect on a paused-for-scope run, whose resume depends
    // on the transcript that vanished.
    let driven = drive(&runs, &run_id, &task, &mut transcript, &deps, &mut read_ids).await;
    let outcome: LoopOutcome = match driven {
        Ok(o) => o,
        Err(e) => {
            // Put back what was taken, so the next step or the review screen
            // still sees the work. Best-effort by construction: if the session
            // is gone the run is over and there is nothing to preserve.
            let mut table = sessions
                .sessions
                .lock()
                .expect("agent session table poisoned");
            if let Some(s) = table.get_mut(&run_id) {
                s.transcript = transcript;
                s.read_ids = read_ids;
                s.proposal = proposal;
                // **And the flag, on the FAILURE path too.** Releasing only on
                // success is how an in-flight marker turns one failed model call
                // into a permanently wedged run: the flag stays set, every later
                // step reports `StepAlreadyRunning`, and nothing clears it short
                // of a vault lock. Both exits from this function release it, and
                // there is no `?` between the claim and either of them.
                s.in_flight = false;
            }
            // The one place a step's failure is visible at all
            // (myne-md/myne#546). The surface renders "The agent could not
            // start", which names no cause, and until this line the host left
            // no trace of one either: a start that failed on a debug build with
            // logging on produced zero output. `kind()` rather than the error,
            // because two variants carry a note id.
            tracing::debug!(
                target: "myne::agent",
                event = "step_failed",
                error_kind = e.kind(),
            );
            return Err(e);
        }
    };

    // Accumulate across resumes: a run that paused for a scope approval and
    // resumed has one proposal, not two.
    proposal.edits.extend(outcome.proposal.edits);
    proposal.new_notes.extend(outcome.proposal.new_notes);
    if !outcome.proposal.summary.is_empty() {
        proposal.summary = outcome.proposal.summary;
    }

    {
        let mut table = sessions
            .sessions
            .lock()
            .expect("agent session table poisoned");
        if let Some(s) = table.get_mut(&run_id) {
            s.transcript = transcript;
            s.read_ids = read_ids;
            s.proposal = proposal.clone();
            s.in_flight = false;
        }
    }

    // A cancel the loop has now observed is terminal, so the run and its session
    // go together. Not done in `agent_cancel`: that only sets the flag, and
    // removing the run there would race the in-flight loop into `NoSuchRun`
    // instead of the `Cancelled` end it is written to return. A `Finished` run
    // deliberately stays (the apply reads its frozen scope); see
    // `AgentRunState::end`.
    let cancelled = matches!(outcome.end, LoopEnd::Cancelled);
    let view = runs.view(&run_id)?;
    if cancelled {
        runs.end(&run_id);
        sessions
            .sessions
            .lock()
            .expect("agent session table poisoned")
            .remove(&run_id);
    }

    Ok(AgentStepResult {
        view,
        proposal,
        end: outcome.end,
        iterations: outcome.iterations,
        notes_read: outcome.notes_read,
        chars_off_device: outcome.chars_off_device,
        excluded_count,
    })
}

/// Start a run: resolve the initial scope, then drive until it stops.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_start<R: Runtime>(
    app: AppHandle<R>,
    task: String,
    grant: ScopeGrant,
    // The user's interface language, as a BCP-47 tag. Supplied by the WebView
    // because that is where it lives: the chosen language is in `localStorage`
    // (`src/i18n/index.ts`), not in `vault.prefs`, so the host cannot read it.
    // Shape-checked before it reaches the system message; see
    // `prompt::system_instructions`, which drops anything that is not a tag.
    language: Option<String>,
    // The visible chat turns, oldest first, as the client reports them. The
    // BUDGET is applied here rather than by the caller: what reaches the model
    // is host policy, and a WebView that pre-trimmed would be deciding it.
    history: Vec<HistoryTurn>,
    on_open: Channel<AgentRunView>,
    runs: State<'_, Arc<AgentRunState>>,
    sessions: State<'_, AgentSessionState>,
    indices: State<'_, VaultIndicesState>,
    vault: State<'_, VaultRuntimeState>,
    ai: State<'_, LocalInferenceState>,
    vectors: State<'_, LocalInferenceVectorState>,
) -> Result<AgentStepResult, AgentError> {
    require_unlocked(&vault).await?;
    // One prefs read serves both the gate and the budget.
    let start_view = require_ai_enabled(&app, &vault).await?;
    let seed_context = SeedContext::of(&start_view);
    let budget = history_budget(&start_view);
    let source = DesktopScopeSource {
        app: app.clone(),
        vault: vault.inner(),
        indices: indices.inner(),
    };
    // **v7, not v4, and the eviction depends on it.** `AgentRunState::start`
    // bounds the table by dropping `BTreeMap`'s first key, which it documents as
    // the oldest run. That is only true for a time-ordered id: under v4 the
    // first key is the lexically smallest RANDOM id, so at the cap the eviction
    // cancelled an arbitrary run and the one the user was reviewing could go
    // while an older idle one survived. Found in the review of myne-md/myne#531.
    //
    // A v7 carries a millisecond timestamp, and this one does not leave the
    // device: the run id is RAM-only, never persisted, and never reaches the
    // model (nothing in `prompt.rs` or `engine.rs` reads it), so it does not
    // widen what crosses TB13.
    let run_id = myne_core::plugins::agent::run::new_run_id();
    let (resolved, cancel) = start_run(&runs, run_id.clone(), &grant, &source).await?;
    // **Prune AFTER the start, which is the only moment a run can be evicted.**
    // `AgentRunState` caps at `MAX_LIVE_RUNS` and drops the oldest to make room
    // for this one; nothing removed the evicted run's session, so its task, its
    // transcript of whole note bodies and its proposal of verbatim anchors
    // stayed resident until the vault locked. The eviction is in core and this
    // table is desktop-side, so the prune asks core what is still live rather
    // than being told what went (myne-md/myne#531 review round six).
    sessions.prune_to(&runs.live_ids());
    sessions
        .sessions
        .lock()
        .expect("agent session table poisoned")
        .insert(
            run_id.clone(),
            Session {
                task,
                language,
                history: seed_messages(&history, budget),
                seed_context,
                ..Default::default()
            },
        );
    // **Before the loop, not after it.** This command returns once the loop has
    // stopped, which on a remote provider is minutes, and until myne-md/myne#544
    // that return was the only thing that ever handed the surface a run id. So
    // for the whole first leg the run was `running` with no id: no status, no
    // running scope total, and no Stop, on a run that is at that moment sending
    // note text to a provider. `AgentProgress`'s own module note says the scope
    // total "is shown continuously"; this is what makes that true.
    //
    // A channel rather than a second command, because the id has to arrive
    // DURING this call, and rather than an event, because a channel is an
    // ordinary parameter: no new command, no capability ACL change, and the
    // same shape `chat_stream` already uses for its tokens.
    //
    // A send that fails is ignored on purpose: a closed channel means the
    // surface let go of this run, and the run is unaffected either way.
    if let Ok(view) = runs.view(&run_id) {
        let _ = on_open.send(view);
    }

    // **Wall-clock, measured HERE rather than inside the loop**
    // (myne-md/myne#568). `core/` compiles for `wasm32-unknown-unknown`, where
    // `Instant::now()` compiles and then panics (`core/src/host.rs`), so timing
    // the loop itself would mean threading a clock through `LoopDeps`. This
    // crate is desktop-only and this is the whole user-visible call, which is
    // the figure that was missing: a session sat at "Working" for minutes with
    // no way to tell whether the time was the provider's or ours. It was the
    // provider's, and now that is readable rather than inferred.
    let started = std::time::Instant::now();
    let outcome = step(
        app,
        run_id,
        Arc::clone(&runs),
        &sessions,
        &indices,
        &vault,
        &ai,
        &vectors,
        cancel,
        resolved.excluded_count,
    )
    .await;
    tracing::debug!(
        target: "myne::agent",
        event = "agent_start_returned",
        elapsed_ms = started.elapsed().as_millis() as u64,
        // A boolean, not the error: `step_failed` one frame in already logs the
        // `kind`, and repeating it here would be a second place to keep the DENY
        // list true.
        ok = outcome.is_ok(),
    );
    outcome
}

/// Approve a scope expansion and resume the run.
///
/// The origin is `Model` because this command exists to answer a request the
/// model made. A user widening the scope themselves goes through `agent_start`
/// with a wider grant, which is `User`. Neither is read from the payload.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_approve_scope<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    grant: ScopeGrant,
    runs: State<'_, Arc<AgentRunState>>,
    sessions: State<'_, AgentSessionState>,
    indices: State<'_, VaultIndicesState>,
    vault: State<'_, VaultRuntimeState>,
    ai: State<'_, LocalInferenceState>,
    vectors: State<'_, LocalInferenceVectorState>,
) -> Result<AgentStepResult, AgentError> {
    require_unlocked(&vault).await?;
    // The view is KEPT rather than discarded: the scope-approval pause is a
    // user-length window, and it is the window in which the exclusion set or the
    // provider can move under a run that is already seeded.
    let view = require_ai_enabled(&app, &vault).await?;
    cut_seed_if_context_changed(&sessions, &run_id, &view);
    let source = DesktopScopeSource {
        app: app.clone(),
        vault: vault.inner(),
        indices: indices.inner(),
    };
    let resolved = expand_run(&runs, &run_id, &grant, GrantOrigin::Model, &source).await?;
    // The run's OWN flag, not a fresh one seeded from its current value: a copy
    // is a flag nothing else writes to, and Stop and the lock teardown would
    // both be inert for this leg.
    let cancel = runs.cancel_flag(&run_id)?;
    step(
        app,
        run_id,
        Arc::clone(&runs),
        &sessions,
        &indices,
        &vault,
        &ai,
        &vectors,
        cancel,
        resolved.excluded_count,
    )
    .await
}

/// What a grant would resolve to, without committing it.
///
/// The approval screen is the gate, and a gate that states numbers the host will
/// not honour is not one. This runs the SAME `resolve_grant` the commit runs,
/// against the same index snapshot and the same `ai_excluded_folders`, so the
/// count, the removed count and the resulting total are the host's answers
/// rather than the WebView's arithmetic.
///
/// It is a preview, not a reservation: the set is resolved again when the grant
/// is actually approved. The two can differ if the vault changes in between, and
/// that is correct: the frozen set is the one taken at approval, not at preview.
#[tauri::command]
pub async fn agent_preview_grant<R: Runtime>(
    app: AppHandle<R>,
    run_id: Option<String>,
    grant: ScopeGrant,
    runs: State<'_, Arc<AgentRunState>>,
    indices: State<'_, VaultIndicesState>,
    vault: State<'_, VaultRuntimeState>,
) -> Result<GrantPreview, AgentError> {
    require_unlocked(&vault).await?;
    // The opt-in, re-read host-side like every sibling that reaches the vault.
    // `mod.rs` and `decisions/ai/0515` both said this command did; it did not,
    // which made two documents wrong about a TB6 surface rather than merely
    // leaving a gap. Cheaper to make the claim true than to record an exception
    // nobody wanted.
    require_ai_enabled(&app, &vault).await?;
    let source = DesktopScopeSource {
        app: app.clone(),
        vault: vault.inner(),
        indices: indices.inner(),
    };
    let (resolved, new_total) = preview_grant(&runs, run_id.as_deref(), &grant, &source).await?;
    Ok(GrantPreview {
        note_count: resolved.note_ids.len(),
        excluded_count: resolved.excluded_count,
        unknown_count: resolved.unknown_count,
        new_total,
    })
}

/// Cancel a run.
#[tauri::command]
pub async fn agent_cancel(
    run_id: String,
    runs: State<'_, Arc<AgentRunState>>,
) -> Result<bool, AgentError> {
    Ok(runs.cancel(&run_id))
}

/// Apply the edits the user approved on the review screen.
///
/// `approval` says HOW the user approved: one edit on its own, or a batch in one
/// action. It is the only policy input this command takes, and it is a fact
/// about the click rather than about the edits, which is why the host cannot
/// derive it and has to be told. Everything it implies is then enforced
/// host-side: a `Bulk` batch cannot trash a note, and the refusal is reported
/// like any other rather than failing the batch.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_apply<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    approved: Vec<ProposedEdit>,
    approved_new_notes: Vec<usize>,
    approval: Approval,
    runs: State<'_, Arc<AgentRunState>>,
    sessions: State<'_, AgentSessionState>,
    indices: State<'_, VaultIndicesState>,
    vault: State<'_, VaultRuntimeState>,
    hooks: State<'_, myne_core::hooks::Hooks>,
) -> Result<ApplyOutcome, AgentError> {
    require_unlocked(&vault).await?;
    require_ai_enabled(&app, &vault).await?;
    // The excluded-folder set is re-read HERE, at the write, rather than carried
    // from the run that proposed these edits. A user who excludes a folder while
    // a proposal sits on the review screen means it, and the newest answer is the
    // one that should decide what gets created.
    let excluded = DesktopScopeSource {
        app: app.clone(),
        vault: vault.inner(),
        indices: indices.inner(),
    }
    .excluded_folders()
    .await?;
    // READ, not take. Consumption happens after the apply, keyed off what it
    // actually created, so a failure leaves every approved note retryable.
    let new_notes = sessions.read_approved_new_notes(&run_id, &approved_new_notes);
    // The edit-side twin: only edits the host recorded the model proposing are
    // applied, and the rest are reported rather than dropped. The indices are
    // positions in the APPROVED list, which is what `RefusedEdit::index` means
    // everywhere else on this path.
    let (approved, not_proposed) = sessions.retain_proposed_edits(&run_id, &approved);
    let reader = NoteReadAdapter {
        host: TauriHost::new(app.clone()),
        state: vault.inner(),
    };
    let restore = RestoreAdapter {
        host: TauriHost::new(app.clone()),
        state: vault.inner(),
    };
    let writer = WriteAdapter {
        host: TauriHost::new(app),
        state: vault.inner(),
        hooks: hooks.inner().clone(),
    };
    let mut outcome = apply_approved(
        &runs, &run_id, &approved, &new_notes, &excluded, approval, &reader, &restore, &writer,
    )
    .await?;
    for index in not_proposed {
        outcome.refused.push(RefusedEdit {
            note_id: String::new(),
            index,
            reason: EditRejection::NotProposed,
        });
    }
    // Now drop the ones that landed, and only those. On the `?` above nothing is
    // consumed, which is the point: the user can retry and the notes are still
    // there. A per-note `createFailed` refusal is retryable for the same reason.
    sessions.consume_created_new_notes(&run_id, &outcome.created_new_note_indices);
    // Record it under the run id, so undo survives the review screen closing.
    // Recorded only when something was actually written: an apply whose every
    // edit was refused took no restore point, and offering to undo it would be
    // an offer to restore nothing.
    if !outcome.restore_points.is_empty() || !outcome.notes_created.is_empty() {
        runs.record_applied(AppliedRun {
            run_id: run_id.clone(),
            restore_points: outcome.restore_points.clone(),
            notes_created: outcome.notes_created.len(),
        });
    }
    Ok(outcome)
}

/// The run the user could still undo, if there is one.
///
/// Exists so the affordance can be offered somewhere other than the screen that
/// applied it. Returns identifiers only, never note text.
#[tauri::command]
pub async fn agent_last_run(
    runs: State<'_, Arc<AgentRunState>>,
    vault: State<'_, VaultRuntimeState>,
) -> Result<Option<AppliedRun>, AgentError> {
    require_unlocked(&vault).await?;
    Ok(runs.last_applied())
}

/// Revert a whole agent run, as one action.
///
/// **Takes the run id, and looks the record up host-side.** The earlier shape
/// took the `(note_id, snapshot_id)` list from the caller, which had two costs:
/// the run id was decorative, since nothing was stored under it, and the record
/// lived only in the review screen, so closing that screen made a documented
/// guarantee stop being true. Now the apply stores it under the run and this
/// command consumes it, so a second undo of the same run reports
/// [`AgentError::NoSuchRun`] instead of restoring the same snapshots over
/// whatever the user has written since.
///
/// One command rather than N snapshot restores from the frontend, because "the
/// whole run reverts as one action" is the property the restore point exists
/// for, and a loop in the WebView is a property that holds only while nobody
/// interrupts it.
///
/// **Notes the run CREATED are not reverted here**, and the result says how many
/// were left. A create has no snapshot to restore to; undoing one means trashing
/// it, which is a different act with a different confirmation. Reporting the
/// count is what keeps "the run was undone" from meaning more than it did.
///
/// Partial failure is reported rather than rolled back: a snapshot that will not
/// restore is not fixed by refusing to restore the others.
#[tauri::command]
pub async fn agent_undo<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    runs: State<'_, Arc<AgentRunState>>,
    vault: State<'_, VaultRuntimeState>,
    hooks: State<'_, myne_core::hooks::Hooks>,
) -> Result<AgentUndoResult, AgentError> {
    require_unlocked(&vault).await?;
    let record = runs.take_applied(&run_id)?;
    let notes_created = record.notes_created;
    let host = TauriHost::new(app);
    let mut reverted = 0usize;
    let mut failed = Vec::new();
    for (note_id, snapshot_id) in record.restore_points {
        let snapshot_id_for_retry = snapshot_id.clone();
        match snapshot_restore_from_host(
            &host,
            vault.inner(),
            hooks.inner(),
            note_id.clone(),
            snapshot_id,
            &StdVaultIo,
        )
        .await
        {
            Ok(()) => reverted += 1,
            Err(_) => failed.push((note_id, snapshot_id_for_retry)),
        }
    }
    // **Put the FAILED points back, so the undo can be retried.**
    // `take_applied` consumes deliberately: a second undo of the same record
    // would restore the same snapshots over whatever the user has written since,
    // which would look successful. That reasoning covers the notes that WERE
    // restored and not the ones that were not. Those were never touched, so a
    // retry cannot overwrite anything, and consuming the whole record made a
    // partial failure permanent. Found in the review of myne-md/myne#531.
    //
    // `notes_created` is not carried back: those notes are still there, an undo
    // never reverted them, and re-reporting the count on a retry would say the
    // second attempt left them behind as if that were news.
    if !failed.is_empty() {
        runs.record_applied(AppliedRun {
            run_id: run_id.clone(),
            restore_points: failed.clone(),
            notes_created: 0,
        });
    }
    let failed: Vec<String> = failed.into_iter().map(|(id, _)| id).collect();
    Ok(AgentUndoResult {
        reverted,
        failed,
        notes_created_not_reverted: notes_created,
    })
}

/// What an undo did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUndoResult {
    /// How many notes were restored to their pre-apply text.
    pub reverted: usize,
    /// Notes whose snapshot would not restore. Named so the user can act.
    pub failed: Vec<String>,
    /// How many notes the run CREATED and this undo therefore left in place.
    pub notes_created_not_reverted: usize,
}

/// Whether agent mode can run on the configured backend, and why not.
#[tauri::command]
pub async fn agent_capability<R: Runtime>(
    app: AppHandle<R>,
    // **The wait, reported while it is a wait** (myne-md/myne#575). This command
    // returns once, when everything is done, which was measured at 40 seconds;
    // until then the surface showed one unchanging label and read as a hang. A
    // `Channel` rather than an event, for the reason `agent_start`'s `on_open`
    // gives: it is an ordinary parameter, so there is no new command and no ACL
    // change.
    on_attempt: Channel<ProbeProgress>,
    ai: State<'_, LocalInferenceState>,
    vault: State<'_, VaultRuntimeState>,
) -> Result<ProbeVerdict, AgentError> {
    require_unlocked(&vault).await?;
    require_ai_enabled(&app, &vault).await?;
    let engine = EngineAdapter {
        state: ai.inner(),
        cancel: Arc::new(AtomicBool::new(false)),
    };
    // **What the probe COSTS, which nothing said** (myne-md/myne#568). It issues
    // `threshold.attempts` requests to the configured provider; on a remote one
    // that was measured at 8 seconds, spent before the user's first message is
    // sent, and the surface shows only "Checking the model".
    //
    // There is deliberately no `cached` field to go with it. The verdict is now
    // remembered for the session in `agentStore`, and when it is remembered this
    // command is not called at all — so the ABSENCE of this line is the cache. A
    // flag that could only ever read `false` would be a claim the code cannot
    // make.
    let started = std::time::Instant::now();
    // A failed send is ignored, exactly as `agent_start`'s is: a closed channel
    // means the surface let go, and the probe is unaffected either way.
    let sink = move |p: ProbeProgress| {
        let _ = on_attempt.send(p);
    };
    let verdict = run_probe(&engine, probe_threshold(), &sink).await;
    tracing::debug!(
        target: "myne::agent",
        event = "probe_returned",
        elapsed_ms = started.elapsed().as_millis() as u64,
        // Counts and a boolean. `ProbeVerdict::attempts` carries a `detail`
        // string per failed attempt, which is model output, so it is not logged
        // here.
        passed = verdict.as_ref().map(|v| v.passed).unwrap_or(false),
        passes = verdict.as_ref().map(|v| v.passes).unwrap_or(0),
        // What was actually ASKED. Since the early exit this is the number the
        // elapsed time above is explained by, and it differs from the threshold
        // whenever the verdict settled early.
        asked = verdict.as_ref().map(|v| v.attempts.len()).unwrap_or(0),
    );
    verdict
}

#[cfg(test)]
mod tests {

    /// The READ half of `chat_history_budget`, which had no test at all: the
    /// write is asserted on disk in `core/src/plugins/prefs/commands.rs`, and
    /// replacing this function's body with `DEFAULT_HISTORY_BUDGET` left every
    /// suite green. The three-way is the user-visible contract the settings
    /// panel states, and only one of the three arms is the default.
    #[test]
    fn the_history_budget_read_distinguishes_unset_from_zero() {
        use myne_core::plugins::agent::history::DEFAULT_HISTORY_BUDGET;

        let unset = PrefsView {
            chat_history_budget: None,
            ..PrefsView::default()
        };
        assert_eq!(
            super::history_budget(&unset),
            DEFAULT_HISTORY_BUDGET,
            "empty means the host default"
        );

        let none_at_all = PrefsView {
            chat_history_budget: Some(0),
            ..PrefsView::default()
        };
        assert_eq!(
            super::history_budget(&none_at_all),
            0,
            "zero means seed nothing, which is a real choice and not the default"
        );

        let chosen = PrefsView {
            chat_history_budget: Some(500),
            ..PrefsView::default()
        };
        assert_eq!(super::history_budget(&chosen), 500);
        assert_ne!(
            super::history_budget(&chosen),
            DEFAULT_HISTORY_BUDGET,
            "a smaller number must actually send less, which is the direction that matters"
        );
    }
    use super::*;
    use std::collections::BTreeSet;

    // ---- the run id reaches the surface before the loop runs -------------

    /// `agent_start` sends the run's view BEFORE it drives the loop.
    ///
    /// The ordering is the entire fix (myne-md/myne#544): this command returns
    /// when the loop has stopped, so a send placed after `step(...)` would be
    /// indistinguishable from the return value it already had, and the first
    /// leg would stay a `running` run with no id, no scope total and no Stop.
    ///
    /// Read off the source, which is unusual and is the honest option here: the
    /// command needs an `AppHandle`, a `Channel` and five `State`s, none of
    /// which a unit test can build, so the alternative is not a better test but
    /// no test. Both anchors are asserted to exist first, so a rename fails by
    /// name rather than passing on a string this can no longer find.
    #[test]
    fn the_run_view_is_sent_before_the_loop_is_driven() {
        let src = include_str!("commands.rs");
        let start = src
            .find("pub async fn agent_start<R: Runtime>")
            .expect("agent_start is still named that");
        let body = &src[start..];
        let send = body
            .find("on_open.send(view)")
            .expect("agent_start still sends the view through the open channel");
        // `= step(`, not `    step(`: the call is bound to a local now, so that
        // its wall-clock can be logged after it returns (myne-md/myne#568), and
        // the indent-anchored needle stopped matching. Keyed on the binding
        // rather than on the bare name because `AgentStepResult` and the doc
        // comments above contain "step" too, and a needle that matches prose
        // would let the call itself move above the send while this test still
        // passed.
        let drive = body
            .find("= step(")
            .expect("agent_start still drives a step");
        assert!(
            send < drive,
            "the view must be sent before the loop is driven, or the first leg \
             has no id again and nothing can cancel it"
        );
    }

    // ---- the compiled-in probe threshold --------------------------------

    /// The strictness that used to live in an `assert_eq!` inside
    /// `probe_threshold`, moved here so it fails a `cargo test` rather than an
    /// IPC call.
    #[test]
    fn the_compiled_in_threshold_file_is_well_formed() {
        let parsed = parse_probe_threshold(PROBE_THRESHOLD_JSON)
            .expect("agent-probe-threshold.json must parse and be self-consistent");
        assert!(
            parsed.required <= parsed.attempts,
            "a bar of {} out of {} attempts can never be cleared",
            parsed.required,
            parsed.attempts
        );
    }

    /// Both directions of the status/measurements agreement, injected. The
    /// check is worth nothing unless it has been seen to fire, and a check that
    /// is only ever run against a passing input has not been.
    #[test]
    fn a_record_that_disagrees_with_itself_is_refused_both_ways() {
        let claims_measured =
            r#"{"attempts":3,"required":2,"status":"measured","measurements":[]}"#;
        assert!(
            parse_probe_threshold(claims_measured).is_err(),
            "`measured` with no measurements is a claim nobody made"
        );
        let claims_unmeasured =
            r#"{"attempts":3,"required":2,"status":"unmeasured","measurements":[{"backend":"x"}]}"#;
        assert!(
            parse_probe_threshold(claims_unmeasured).is_err(),
            "`unmeasured` with measurements has stopped describing itself"
        );
        assert!(
            parse_probe_threshold("not json").is_err(),
            "a malformed record is refused rather than parsed into a default"
        );
    }

    /// The fallback direction: unreadable must mean UNAVAILABLE, not available.
    #[test]
    fn an_unreadable_record_falls_back_to_a_bar_no_backend_clears() {
        // Driving the fallback through the real function rather than asserting
        // the literal: what matters is what a caller receives when the parse
        // fails, and a test that restated the constant would pass against a
        // version that never used it.
        let fallback = parse_probe_threshold("not json").unwrap_or(ProbeThreshold {
            attempts: 1,
            required: u8::MAX,
            provisional: true,
        });
        assert!(
            fallback.required > fallback.attempts,
            "fail-closed: an unreadable threshold must be unclearable, not permissive"
        );
        assert!(fallback.provisional, "and it must not claim to be measured");
    }

    fn note(title: &str) -> ProposedNote {
        ProposedNote {
            title: title.into(),
            body: "body".into(),
            folder: None,
        }
    }

    fn session_with(notes: &[&str]) -> AgentSessionState {
        let st = AgentSessionState::default();
        let mut table = st.sessions.lock().unwrap();
        let mut s = Session::default();
        s.proposal.new_notes = notes.iter().map(|t| note(t)).collect();
        table.insert("r".to_string(), s);
        drop(table);
        st
    }

    fn remaining(st: &AgentSessionState) -> Vec<String> {
        st.sessions
            .lock()
            .unwrap()
            .get("r")
            .map(|s| {
                s.proposal
                    .new_notes
                    .iter()
                    .map(|n| n.title.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Reading the approved notes must not remove them.
    ///
    /// The consuming version ran BEFORE the apply, which can still fail, and on
    /// failure the notes were gone from the record and never created: the screen
    /// kept rendering them, a retry sent the same indices, found a shorter list,
    /// and silently created nothing.
    #[test]
    fn reading_approved_new_notes_leaves_the_record_intact_for_a_retry() {
        let st = session_with(&["A", "B", "C"]);
        let read = st.read_approved_new_notes("r", &[0, 2]);
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].0, 0);
        assert_eq!(read[1].0, 2);
        // The state, not the return value: a read that reported the right pair
        // while removing them would pass a return-value assertion.
        assert_eq!(remaining(&st), vec!["A", "B", "C"]);
    }

    /// And consuming drops exactly what landed, so a partial apply stays
    /// retryable for the rest.
    #[test]
    fn consuming_drops_only_the_notes_that_were_created() {
        let st = session_with(&["A", "B", "C"]);
        st.consume_created_new_notes("r", &[1]);
        assert_eq!(remaining(&st), vec!["A", "C"]);
    }

    #[test]
    fn consuming_nothing_is_what_a_failed_apply_does() {
        let st = session_with(&["A", "B"]);
        st.consume_created_new_notes("r", &[]);
        assert_eq!(remaining(&st), vec!["A", "B"]);
    }

    #[test]
    fn an_out_of_range_index_is_dropped_rather_than_erroring() {
        // Only a stale screen can send one, and refusing the whole apply over it
        // is worse than applying the rest.
        let st = session_with(&["A"]);
        assert_eq!(st.read_approved_new_notes("r", &[0, 9]).len(), 1);
        st.consume_created_new_notes("r", &[9]);
        assert_eq!(remaining(&st), vec!["A"]);
    }

    #[test]
    fn the_probe_threshold_parses_from_the_recorded_file() {
        let t = probe_threshold();
        assert!(t.attempts >= 1);
        assert!(t.required >= 1);
        assert!(
            t.required <= t.attempts,
            "a bar higher than the attempt count could never be met"
        );
    }

    #[test]
    fn the_recorded_threshold_file_says_whether_it_was_measured() {
        // The number is debt until someone runs the probe against real models.
        // Asserting the field exists is what keeps the honesty from being
        // quietly dropped in a later edit.
        let v: serde_json::Value = serde_json::from_str(PROBE_THRESHOLD_JSON).unwrap();
        assert!(v.get("status").is_some(), "the file states its own status");
        assert!(
            v.get("measurements").is_some(),
            "and carries the measurements, or an empty list saying there are none"
        );
    }

    #[test]
    fn sessions_clear_leaves_none_behind() {
        let s = AgentSessionState::default();
        s.sessions.lock().unwrap().insert(
            "r".into(),
            Session {
                task: "t".into(),
                ..Default::default()
            },
        );
        assert_eq!(s.len(), 1);
        s.clear();
        assert!(s.is_empty(), "no transcript survives a lock");
    }

    // ---- the session table's bound ---------------------------------------

    fn session_with_task(task: &str) -> Session {
        Session {
            task: task.into(),
            ..Default::default()
        }
    }

    /// The run table caps and evicts; this table did not, so an evicted run's
    /// plaintext stayed resident until the vault locked
    /// (myne-md/myne#531 review round six).
    #[test]
    fn a_session_whose_run_was_evicted_is_dropped() {
        let s = AgentSessionState::default();
        {
            let mut t = s.sessions.lock().unwrap();
            t.insert("evicted".into(), session_with_task("old"));
            t.insert("live".into(), session_with_task("current"));
        }
        assert_eq!(s.len(), 2);
        s.prune_to(&BTreeSet::from(["live".to_string()]));
        let table = s.sessions.lock().unwrap();
        assert_eq!(
            table.keys().cloned().collect::<Vec<_>>(),
            vec!["live".to_string()],
            "only the run core still holds keeps its session"
        );
    }

    /// The direction a prune is most likely to break: pruning must not remove a
    /// session whose run is live, which would take the transcript out from under
    /// a running step.
    #[test]
    fn a_live_run_keeps_its_session() {
        let s = AgentSessionState::default();
        s.sessions
            .lock()
            .unwrap()
            .insert("r".into(), session_with_task("t"));
        s.prune_to(&BTreeSet::from(["r".to_string(), "other".to_string()]));
        assert_eq!(s.len(), 1);
    }

    /// The prune drives the SAME wipe the lock teardown does, so the two cannot
    /// drift into different notions of "gone". Asserted through `wipe_session`
    /// directly, because a dropped session's memory cannot be read afterwards
    /// and a test that claimed to check it would be claiming more than its
    /// inputs can prove.
    #[test]
    fn the_prune_and_the_lock_teardown_wipe_through_one_function() {
        let mut session = Session {
            task: "secret task".into(),
            ..Default::default()
        };
        session.proposal.summary = "secret summary".into();
        wipe_session(&mut session);
        assert!(session.task.bytes().all(|b| b == 0), "task overwritten");
        assert!(
            session.proposal.summary.bytes().all(|b| b == 0),
            "summary overwritten"
        );
    }
}
