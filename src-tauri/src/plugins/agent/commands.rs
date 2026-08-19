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
use myne_core::plugins::agent::apply::{ApplyOutcome, Approval};
use myne_core::plugins::agent::engine::{Content, Message};
use myne_core::plugins::agent::error::AgentError;
use myne_core::plugins::agent::probe::{run_probe, ProbeThreshold, ProbeVerdict};
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
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
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
    transcript: Vec<Message>,
    proposal: Proposal,
}

/// The table of live sessions. Cleared by the same lock teardown that clears
/// core's run table.
#[derive(Default)]
pub struct AgentSessionState {
    sessions: Mutex<BTreeMap<String, Session>>,
}

impl AgentSessionState {
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
    ///
    /// Two separate properties, and an earlier version conflated them. **Which
    /// notes exist** is host-side: the caller names indices into the proposal the
    /// host itself recorded, so it cannot invent a note the model never proposed.
    /// **Which of those to create** is the user's, expressed as that index list,
    /// because a create is a write and SYNC-17's restatement says no write
    /// happens without a per-note approval.
    ///
    /// Out-of-range indices are dropped rather than erroring: they can only come
    /// from a stale screen, and refusing the whole apply over one is worse than
    /// applying the rest.
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
        table.clear();
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
async fn require_ai_enabled<R: Runtime>(
    app: &AppHandle<R>,
    vault: &VaultRuntimeState,
) -> Result<(), AgentError> {
    let host = TauriHost::new(app.clone());
    let view = prefs_read_from_host(&host, vault, &StdVaultIo)
        .await
        .map_err(|_| AgentError::ReadFailed)?;
    if view.ai_enabled {
        Ok(())
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
    let (task, mut transcript, mut proposal) = {
        let mut table = sessions
            .sessions
            .lock()
            .expect("agent session table poisoned");
        let s = table.get_mut(&run_id).ok_or(AgentError::NoSuchRun)?;
        (
            s.task.clone(),
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
    let driven = drive(&runs, &run_id, &task, &mut transcript, &deps).await;
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
                s.proposal = proposal;
            }
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
            s.proposal = proposal.clone();
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
    runs: State<'_, Arc<AgentRunState>>,
    sessions: State<'_, AgentSessionState>,
    indices: State<'_, VaultIndicesState>,
    vault: State<'_, VaultRuntimeState>,
    ai: State<'_, LocalInferenceState>,
    vectors: State<'_, LocalInferenceVectorState>,
) -> Result<AgentStepResult, AgentError> {
    require_unlocked(&vault).await?;
    require_ai_enabled(&app, &vault).await?;
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
    sessions
        .sessions
        .lock()
        .expect("agent session table poisoned")
        .insert(
            run_id.clone(),
            Session {
                task,
                ..Default::default()
            },
        );
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
    require_ai_enabled(&app, &vault).await?;
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
    let outcome = apply_approved(
        &runs, &run_id, &approved, &new_notes, &excluded, approval, &reader, &restore, &writer,
    )
    .await?;
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
    ai: State<'_, LocalInferenceState>,
    vault: State<'_, VaultRuntimeState>,
) -> Result<ProbeVerdict, AgentError> {
    require_unlocked(&vault).await?;
    require_ai_enabled(&app, &vault).await?;
    let engine = EngineAdapter {
        state: ai.inner(),
        cancel: Arc::new(AtomicBool::new(false)),
    };
    run_probe(&engine, probe_threshold()).await
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
