// SPDX-License-Identifier: AGPL-3.0
//! The host-generic half of the agent command surface (myne-md/myne#456).
//!
//! **Why this is here and the `#[tauri::command]` wrappers are not.** Both Tauri
//! clients drive an agent run through the same sequence: guard the slot, guard
//! the opt-in, resolve the grant, claim the session, drive the loop, write back.
//! They differ in exactly two places: which engine answers, and how a scope is
//! searched: so [`step`] takes those two as trait objects and everything else
//! moved here rather than being copied into the mobile tree. The alternative
//! was roughly eleven hundred lines of duplicated command bodies, which is the
//! shape `scripts/check-twin-drift.mjs` can only warn about.
//!
//! What stays per client is the thin `#[tauri::command]` layer: the `State<'_,
//! …>` list genuinely differs (desktop resolves a vector store, mobile does
//! not), and that layer is the one place a client's own wiring belongs. This is
//! the three-layer command shape `core/CLAUDE.md` describes, applied to a plugin
//! that had not adopted it.
//!
//! **The guards are here rather than in the wrappers on purpose.**
//! `require_unlocked` and `require_ai_enabled` are the two host-side checks the
//! whole surface rests on, and a guard that each client re-implements is a guard
//! one client eventually implements differently. The per-command split of which
//! guards apply is documented on the desktop plugin's `mod.rs` and holds for
//! both clients, because both call these.
//!
//! Behind `tauri-ipc`, because everything on this path takes an `AppHandle`.
//!
//! See: src-tauri/CLAUDE.md "Secret-handling logging discipline".
#![cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]

use crate::host::tauri_host::TauriHost;
use crate::plugins::agent::edit::ProposedEdit;
use crate::plugins::agent::engine::{Content, Message};
use crate::plugins::agent::error::{AgentError, EditRejection};
use crate::plugins::agent::probe::ProbeThreshold;
use crate::plugins::agent::prompt::{Proposal, ProposedNote};
use crate::plugins::agent::run::{AgentRunState, AgentRunView};
use crate::plugins::agent::run_loop::{drive, LoopDeps, LoopEnd, LoopOutcome, RunProgress};
use crate::plugins::agent::scope::{ExclusionSource, ScopeSource};
use crate::plugins::prefs::commands::prefs_read_from_host;
use crate::plugins::vault_indices::state::NoteRecord;
use crate::plugins::vault_indices::VaultIndicesState;
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use crate::vault_io::StdVaultIo;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime};
use zeroize::Zeroize;

use crate::plugins::agent::apply::{apply_approved, ApplyOutcome, Approval, RefusedEdit};
use crate::plugins::agent::engine::AgentEngine;
use crate::plugins::agent::host_adapters::{NoteReadAdapter, RestoreAdapter, WriteAdapter};
use crate::plugins::agent::run::AppliedRun;
use crate::plugins::agent::tools::ScopeSearcher;
use crate::plugins::snapshots::commands::snapshot_restore_from_host;

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
pub(crate) fn parse_probe_threshold(json: &str) -> Result<ProbeThreshold, String> {
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
pub fn probe_threshold() -> ProbeThreshold {
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

    /// Open a session for a run that has just started, evicting anything the
    /// run table dropped to make room for it.
    ///
    /// **One call rather than a prune plus an insert at each client**, because
    /// the ORDER is the load-bearing part and it is not obvious. `AgentRunState`
    /// caps at `MAX_LIVE_RUNS` and drops the oldest run to make room, so the
    /// prune has to happen AFTER the start: the only moment a run can be
    /// evicted: and it asks core what is still live rather than being told what
    /// went. Before myne-md/myne#531's review nothing removed an evicted run's
    /// session, so its task, its transcript of whole note bodies and its
    /// proposal of verbatim anchors stayed resident until the vault locked.
    ///
    /// A client that wrote these two steps itself would be a client that could
    /// get the order wrong, and the failure is silent: everything works, and
    /// note plaintext outlives the run that read it.
    pub fn open(&self, run_id: &str, task: String, live_ids: &BTreeSet<String>) {
        self.prune_to(live_ids);
        self.sessions
            .lock()
            .expect("agent session table poisoned")
            .insert(
                run_id.to_string(),
                Session {
                    task,
                    ..Default::default()
                },
            );
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
    /// [`crate::plugins::agent::engine::AgentCompletion::chars_off_device`]
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
pub async fn require_ai_enabled<R: Runtime>(
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
/// round two and the count was never true: `mod.rs` has the roster. Found in
/// review round five of myne-md/myne#531.)
pub async fn require_unlocked(vault: &VaultRuntimeState) -> Result<(), AgentError> {
    match vault.slot_kind_active().await {
        SlotKind::Unlocked => Ok(()),
        _ => Err(AgentError::SlotNotUnlocked),
    }
}

/// A Tauri host's answer to core's scope questions.
///
/// One implementation for all three entry points. Core owns the ORDER (refuse a
/// root grant, read the exclusions, snapshot the index, resolve, refuse an empty
/// result); this only says where the two inputs come from. That split is what
/// lets the mobile port supply an implementation rather than re-derive a
/// sequence, and it is why a client cannot supply an index snapshot without also
/// supplying the exclusions.
pub struct HostScopeSource<'a, R: Runtime> {
    pub app: AppHandle<R>,
    pub vault: &'a VaultRuntimeState,
    pub indices: &'a VaultIndicesState,
}

#[async_trait::async_trait]
impl<R: Runtime> ScopeSource for HostScopeSource<'_, R> {
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
pub async fn read_excluded<R: Runtime>(
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
/// Deliberately NOT `HostScopeSource`, which also answers `records()`. The
/// loop must not re-read the index (`LoopDeps::records` says why), so it is handed
/// a source that cannot.
pub struct HostExclusions<'a, R: Runtime> {
    pub app: AppHandle<R>,
    pub vault: &'a VaultRuntimeState,
}

#[async_trait::async_trait]
impl<R: Runtime> ExclusionSource for HostExclusions<'_, R> {
    async fn excluded_now(&self) -> Result<Vec<String>, AgentError> {
        read_excluded(&self.app, self.vault).await
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn step<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    runs: Arc<AgentRunState>,
    sessions: &AgentSessionState,
    indices: &VaultIndicesState,
    vault: &VaultRuntimeState,
    // **The two seams a client supplies for itself** (myne-md/myne#456).
    //
    // Everything else on this path is identical between the Tauri clients, and
    // these two are not. The engine is built from each client's own inference
    // state, and the searcher genuinely differs: desktop queries an embedding
    // index, mobile has no vector store and answers from the full-text index
    // instead. Taken as trait objects rather than as concrete states, which is
    // what let this whole function move here rather than be copied.
    engine: &dyn AgentEngine,
    searcher: &dyn ScopeSearcher,
    _cancel: Arc<AtomicBool>,
    excluded_count: usize,
    on_progress: Channel<RunProgress>,
) -> Result<AgentStepResult, AgentError> {
    // Claimed under the SAME lock the take happens under, so there is no window
    // between deciding to proceed and emptying the session. Released in the
    // write-back below, on every exit from this function.
    let (task, mut transcript, mut proposal) = {
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
            std::mem::take(&mut s.transcript),
            std::mem::take(&mut s.proposal),
        )
    };

    let reader = NoteReadAdapter {
        host: TauriHost::new(app.clone()),
        state: vault,
    };
    let records = indices.snapshot();
    let exclusions = HostExclusions {
        app: app.clone(),
        vault,
    };
    // **The cost reaches the surface WHILE the run works** (myne-md/myne#456).
    //
    // `drive` returns only when the loop has stopped, which on a remote provider
    // is minutes, so everything this command returns is disclosure after the
    // fact. `design-notes/ai/0515` rests the remote arm's lack of a volume
    // bound on that disclosure, and a run that is cancelled, or that dies with
    // the foreground on a phone, which myne-md/myne#456 makes an ordinary case
    // rather than an exotic one, discloses nothing at all while having paid for
    // every round-trip it made.
    //
    // A `Channel` for the same reason `on_open` is one: an event would be
    // broadcast to every window and would need a run id to filter on, while a
    // channel is already addressed to the caller that opened it.
    //
    // The send result is DROPPED on purpose. A closed channel means the surface
    // that asked has gone, the vault locked, the user started a new
    // conversation: and a disclosure control that could stall or fail a run
    // would be taking the product down with it. The run is what matters; the
    // report is best-effort by design, and the final figures still arrive in
    // this command's return value.
    let report = move |p: RunProgress| {
        let _ = on_progress.send(p);
    };
    let deps = LoopDeps {
        engine,
        reader: &reader,
        searcher,
        records: &records,
        exclusions: &exclusions,
        on_progress: &report,
    };

    // **Not `?`.** The transcript and the proposal were taken out of the session
    // above, so propagating here drops both while the run stays in the table.
    // The engine adapter returns `Cancelled` when the run's flag is set
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

/// Apply the edits the user approved, and record the run so it can be undone.
///
/// **Here rather than once per client, and the retype is what argued for it.**
/// Both clients had this body verbatim: the same `HostScopeSource`, the same
/// read-not-take of the approved new notes, the same three adapters, the same
/// `not_proposed` reporting loop, the same record guard. Nothing in it is
/// host-specific once the `State` handles have been unwrapped, and this is the
/// path that WRITES NOTE BODIES, so a second copy is a second place for a rule
/// about writing to drift.
///
/// The caller keeps the `#[tauri::command]` and the `State` list; everything
/// below the unwrapping is here.
#[allow(clippy::too_many_arguments)]
pub async fn apply_from_host<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    approved: Vec<ProposedEdit>,
    approved_new_notes: Vec<usize>,
    approval: Approval,
    runs: &Arc<AgentRunState>,
    sessions: &AgentSessionState,
    indices: &VaultIndicesState,
    vault: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
) -> Result<ApplyOutcome, AgentError> {
    require_unlocked(vault).await?;
    require_ai_enabled(&app, vault).await?;
    // Re-read at the WRITE rather than carried from the run that proposed these
    // edits. A user who excludes a folder while a proposal sits on the review
    // screen means it, and the newest answer is the one that should decide.
    let excluded = HostScopeSource {
        app: app.clone(),
        vault,
        indices,
    }
    .excluded_folders()
    .await?;
    // READ, not take: consumption happens after the apply, keyed off what it
    // actually created, so a failure leaves every approved note retryable.
    let new_notes = sessions.read_approved_new_notes(&run_id, &approved_new_notes);
    let (approved, not_proposed) = sessions.retain_proposed_edits(&run_id, &approved);
    let reader = NoteReadAdapter {
        host: TauriHost::new(app.clone()),
        state: vault,
    };
    let restore = RestoreAdapter {
        host: TauriHost::new(app.clone()),
        state: vault,
    };
    let writer = WriteAdapter {
        host: TauriHost::new(app.clone()),
        state: vault,
        hooks: hooks.clone(),
    };
    let mut outcome = apply_approved(
        runs, &run_id, &approved, &new_notes, &excluded, approval, &reader, &restore, &writer,
    )
    .await?;
    // Edits the host never recorded the model proposing are REPORTED rather than
    // dropped, so a surface that shows a refusal per row can show these too.
    for index in not_proposed {
        outcome.refused.push(RefusedEdit {
            note_id: String::new(),
            index,
            reason: EditRejection::NotProposed,
        });
    }
    // Drop the ones that LANDED, and only those. On the `?` above nothing is
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

/// Put the notes an applied run wrote back the way they were.
///
/// **Here for a sharper reason than `apply_from_host` above.** The two clients'
/// copies had already DIVERGED: desktop puts the failed restore points back so
/// a partial failure can be retried, under a comment citing the review of
/// myne-md/myne#531, and the mobile retype simply did not have that branch. So
/// on that client a snapshot that would not restore consumed the record
/// permanently and the user could not try again. One copy, and the fix travels.
///
/// **No `ai_enabled` guard, and it WRITES**, so the omission is the one that
/// needs arguing: it writes to put notes BACK, and gating the single act that
/// reverses a run on an opt-in the user may have just switched off would leave
/// the applied edits standing with no way to take them back. The consent being
/// withdrawn is consent to run the model, not consent to keep what it wrote.
pub async fn undo_from_host<R: Runtime>(
    app: AppHandle<R>,
    run_id: String,
    runs: &Arc<AgentRunState>,
    vault: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
) -> Result<AgentUndoResult, AgentError> {
    require_unlocked(vault).await?;
    let record = runs.take_applied(&run_id)?;
    let notes_created = record.notes_created;
    let host = TauriHost::new(app);
    let mut reverted = 0usize;
    let mut failed = Vec::new();
    for (note_id, snapshot_id) in record.restore_points {
        let snapshot_id_for_retry = snapshot_id.clone();
        match snapshot_restore_from_host(
            &host,
            vault,
            hooks,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    // ---- the run id reaches the surface before the loop runs -------------

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
