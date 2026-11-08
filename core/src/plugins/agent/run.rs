// SPDX-License-Identifier: AGPL-3.0
//! Agent run state: the identity, the approved scope, the running total and the
//! cancel flag.
//!
//! **The scope lives here as a resolved id set, never as a grant.** A run does
//! not remember that it was granted "Projects"; it remembers which note ids that
//! meant when the user said yes. Everything downstream (the tools' clamp, the
//! apply's out-of-scope refusal) reads this set, so the freezing property holds
//! by construction rather than by every caller remembering not to re-resolve.
//!
//! **There is no cap here, and its absence is a decision.** Neither the size of
//! the scope nor the number of expansions is bounded. What bounds accumulation
//! is that every expansion is separately approved and the running total is shown
//! continuously, which is a *behavioural* bound rather than a structural one.
//! That is stated in `myne-agents/docs/threat-model.md` §7 in those words. A future reader
//! reaching for a cap here should read that section first: adding one is a
//! design reversal, not a hardening tweak.
//!
//! **Cancellation is one flag, not a second mechanism.** The run holds an
//! `Arc<AtomicBool>` and the host's existing per-request cancel token wraps the
//! same `Arc`, so the composer's Stop and the vault-lock teardown both reach it
//! through the path they already use.

use super::error::AgentError;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use zeroize::Zeroize;

/// Where a scope grant came from.
///
/// The distinction is not cosmetic. A grant the **user** initiated is their own
/// act; a grant the **model** requested mid-run is reachable by an instruction
/// embedded in a note the model read. Both are approved by the user, so neither
/// is refused here, but the run counts them separately so the surface can say
/// which kind it is asking about and a later reader can tell the two apart in a
/// run's history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GrantOrigin {
    /// The user set this scope themselves, before or during the run.
    User,
    /// The model asked for it and the user approved.
    Model,
}

/// A run's public shape, as the frontend sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunView {
    /// The run's id.
    pub run_id: String,
    /// How many notes the run may currently read and change. This is the
    /// running total the surface must show continuously.
    pub scope_total: usize,
    /// How many grants the user has approved, split by who asked.
    pub user_grants: u32,
    /// How many grants the model asked for and the user approved.
    pub model_grants: u32,
    /// Whether the run has been cancelled.
    pub cancelled: bool,
}

/// One agent run.
#[derive(Debug)]
struct AgentRun {
    note_ids: BTreeSet<String>,
    user_grants: u32,
    model_grants: u32,
    cancel: Arc<AtomicBool>,
}

/// One setting a run changed, and the value it replaced.
///
/// **In memory only, and it holds a preference value rather than note text.**
/// It exists so `undo` can put the setting back, which is the other half of "a
/// run is reversible as one action". It dies with the run, like everything else
/// about a session's agent state, and it is never persisted: the durable record
/// of a setting is `vault.prefs` itself, and a growing history of past values
/// would be vault-derived state nobody asked for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedSetting {
    /// The settings-index id, so the undo re-resolves which pref to write rather
    /// than being handed a field name by a caller it cannot check.
    pub intent_id: String,
    /// The value in place before the write. `None` when the setting was unset,
    /// which is what tells "put X back" apart from "clear it again".
    pub previous: Option<String>,
    /// The FOLDER in place before the write, for the one target that has two
    /// fields (`files.new-note-location`; myne-md/myne#850).
    ///
    /// **Recorded rather than re-read at undo time, and that is the whole point
    /// of the field.** The undo of "specific/Old/ -> specific/New/" rebuilt the
    /// folder from whatever `vault.prefs` held when the user pressed Undo, which
    /// is the agent's own new folder, so it wrote `New/` back, reported the
    /// setting restored, and permanently replaced the folder the user had. The
    /// bug was invisible in exactly the reading the code invited, because the
    /// undo did read a folder and did write one. `None` here means the target
    /// either has no second field or held none.
    #[serde(default)]
    pub previous_folder: Option<String>,
}

/// What an applied run left behind, so it can be reverted after the surface
/// that applied it is gone.
///
/// **This exists because the record used to live only in the review screen.**
/// Closing that screen dropped it, which made "the whole run can be undone" true
/// for as long as the user kept a screen open and false the moment they did the
/// ordinary thing and closed it. Holding it host-side is also what makes the run
/// id load-bearing rather than decorative: the restore points are stored under
/// it, and `agent_undo` names a run instead of being handed a list of snapshots
/// to restore by a caller it cannot check.
///
/// **No note text.** A `(note_id, snapshot_uuid)` pair is an identifier pair, so
/// this is not a `Zeroizing` surface. It is still vault-scoped and still dies on
/// lock, because a `note_id` is an AS6 creation timestamp and the set of them is
/// a statement about which notes an agent touched.
///
/// **`settings` IS a Zeroizing surface, and it is the one field here that is.**
/// A previous preference value is a folder path or a date format: AS3-class vault
/// structure the model wrote, the same class `wipe_session` overwrites. The two
/// discard sites below therefore overwrite these values while leaving the
/// identifier pairs to drop, which is the one place the two halves differ.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedRun {
    /// The run these restore points belong to.
    pub run_id: String,
    /// `(note_id, snapshot_uuid)` per note the run rewrote.
    pub restore_points: Vec<(String, String)>,
    /// How many notes the run CREATED. Carried because an undo cannot revert
    /// those, and a summary that did not say so would overstate what undo does.
    pub notes_created: usize,
    /// Settings the run changed, with the value each replaced. Empty for a run
    /// that only touched notes, which is every run before this feature.
    pub settings: Vec<AppliedSetting>,
}

impl AppliedRun {
    /// Overwrite the preference values this record holds.
    ///
    /// **Split out because two discard sites need it and a third would otherwise
    /// forget**: `clear` (the lock teardown) and the replace arm of
    /// `record_applied`. The identifier pairs beside them are deliberately left
    /// alone, which `AppliedRun`'s doc explains.
    fn zeroize_preference_values(&mut self) {
        for setting in &mut self.settings {
            if let Some(previous) = setting.previous.as_mut() {
                previous.zeroize();
            }
            if let Some(folder) = setting.previous_folder.as_mut() {
                folder.zeroize();
            }
        }
    }
}

/// Mint a run id.
///
/// **Here rather than at the command boundary, because [`AgentRunState::start`]
/// DEPENDS on the choice.** That function bounds the table by evicting
/// `BTreeMap`'s first key and calls it the oldest run, which is only true for a
/// time-ordered id. The desktop host used to mint its own with `Uuid::new_v4()`,
/// so the first key was the lexically smallest RANDOM id and the eviction
/// cancelled an arbitrary run: the one the user was reviewing could go while an
/// older idle one survived. The requirement lived in a comment in this file and
/// the implementation lived in another crate, which is how they drifted.
///
/// A v7 carries a millisecond timestamp. That is not a disclosure here: the run
/// id is RAM-only, never persisted, and never reaches the model, so it does not
/// widen what crosses TB13.
pub fn new_run_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// How many runs one unlocked session may hold at once.
///
/// Small on purpose: a run is a thing the user started and is reviewing, and
/// more than a handful open at once is not a workflow anyone has. The cap
/// exists because a finished run legitimately outlives its loop (see
/// [`AgentRunState::end`]) and only a vault lock clears the table, so the
/// unbounded case is a long session rather than an attack.
const MAX_LIVE_RUNS: usize = 8;

/// The app-managed table of live runs.
///
/// `std::sync::Mutex` rather than a tokio one, on the `VaultIndicesState`
/// precedent: every access here is a short set operation that completes without
/// an `.await` held across the guard. The model call happens outside it.
#[derive(Debug, Default)]
pub struct AgentRunState {
    runs: Mutex<BTreeMap<String, AgentRun>>,
    /// The most recently applied run, and only the most recent.
    ///
    /// One slot rather than a history, deliberately. Undoing an agent run is an
    /// immediate-aftermath action; the durable per-note path is the snapshots
    /// panel, which already holds every one of these snapshots permanently and
    /// individually. A growing map would be unbounded vault-derived state whose
    /// only new capability is reverting a run from three runs ago, which the
    /// snapshots panel already does one note at a time.
    applied: Mutex<Option<AppliedRun>>,
}

impl AgentRunState {
    /// Start a run with an already-resolved initial scope.
    ///
    /// Resolution happens at the command boundary, not here, so this type never
    /// touches the index and the freezing property has exactly one owner.
    pub fn start(&self, run_id: String, note_ids: BTreeSet<String>) -> Arc<AtomicBool> {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut runs = self.runs.lock().expect("agent run table poisoned");
        // Bound the table. A finished run outlives its loop on purpose (see
        // `end`), and nothing else evicts one before a vault lock, so without a
        // cap a long unlocked session accumulates every run's frozen scope. The
        // oldest goes first and is CANCELLED on the way out, so anything still
        // holding its flag stops rather than running against a table it has
        // fallen out of. `BTreeMap` is ordered by run id, and [`new_run_id`]
        // mints UUIDv7, so the first key is the oldest run. That helper is in
        // this file precisely so the property this loop rests on cannot be
        // chosen elsewhere.
        while runs.len() >= MAX_LIVE_RUNS {
            let Some(oldest) = runs.keys().next().cloned() else {
                break;
            };
            if let Some(run) = runs.remove(&oldest) {
                run.cancel.store(true, Ordering::SeqCst);
            }
        }
        runs.insert(
            run_id,
            AgentRun {
                note_ids,
                user_grants: 1,
                model_grants: 0,
                cancel: Arc::clone(&cancel),
            },
        );
        cancel
    }

    /// Union an approved grant into a run's scope.
    ///
    /// Idempotent on the set: approving the same folder twice does not double
    /// the total, because the set is a set. The grant counter still moves, since
    /// the user did approve twice and a history that hid that would be wrong.
    pub fn expand(
        &self,
        run_id: &str,
        note_ids: BTreeSet<String>,
        origin: GrantOrigin,
    ) -> Result<usize, AgentError> {
        let mut runs = self.runs.lock().expect("agent run table poisoned");
        let run = runs.get_mut(run_id).ok_or(AgentError::NoSuchRun)?;
        if run.cancel.load(Ordering::SeqCst) {
            return Err(AgentError::Cancelled);
        }
        run.note_ids.extend(note_ids);
        match origin {
            GrantOrigin::User => run.user_grants += 1,
            GrantOrigin::Model => run.model_grants += 1,
        }
        Ok(run.note_ids.len())
    }

    /// Whether a note is inside a run's approved scope.
    ///
    /// The single question every tool and the apply path asks. It takes the run
    /// id rather than a set so no caller can pass a scope of its own.
    pub fn contains(&self, run_id: &str, note_id: &str) -> Result<bool, AgentError> {
        let runs = self.runs.lock().expect("agent run table poisoned");
        let run = runs.get(run_id).ok_or(AgentError::NoSuchRun)?;
        Ok(run.note_ids.contains(note_id))
    }

    /// Whether a run may still WRITE.
    ///
    /// `contains_all` answers scope and deliberately not this: the two questions
    /// are different and conflating them is how the second one gets skipped.
    /// Stop sets the same flag the vault-lock teardown sets, and the lock path
    /// was safe only because `clear()` removes the run outright rather than
    /// because anything honoured the flag, so the flag's stated meaning held on
    /// one of its two callers.
    pub fn is_writable(&self, run_id: &str) -> Result<(), AgentError> {
        let runs = self.runs.lock().expect("agent run table poisoned");
        let run = runs.get(run_id).ok_or(AgentError::NoSuchRun)?;
        if run.cancel.load(Ordering::SeqCst) {
            return Err(AgentError::Cancelled);
        }
        Ok(())
    }

    /// Which of `note_ids` are in the run's scope, in the same order.
    ///
    /// One lock and one run lookup for the whole slice. The per-id
    /// [`Self::contains`] is still the right call for a single question, but a
    /// caller classifying N ids with it pays N lock/unlock pairs and N string
    /// comparisons on the run id to answer one question.
    pub fn contains_all(&self, run_id: &str, note_ids: &[String]) -> Result<Vec<bool>, AgentError> {
        let runs = self.runs.lock().expect("agent run table poisoned");
        let run = runs.get(run_id).ok_or(AgentError::NoSuchRun)?;
        Ok(note_ids
            .iter()
            .map(|id| run.note_ids.contains(id))
            .collect())
    }

    /// The run's own cancel flag.
    ///
    /// The ONE way to obtain it after [`Self::start`]. A resumed step that
    /// constructs its own `Arc<AtomicBool>` from a snapshot of `is_cancelled`
    /// gets a flag nothing else writes to, so the composer's Stop and the
    /// vault-lock teardown both go inert for that leg: while every doc comment
    /// still says "one mechanism, two callers". This accessor is what makes that
    /// sentence true on the second leg as well as the first.
    pub fn cancel_flag(&self, run_id: &str) -> Result<Arc<AtomicBool>, AgentError> {
        let runs = self.runs.lock().expect("agent run table poisoned");
        let run = runs.get(run_id).ok_or(AgentError::NoSuchRun)?;
        Ok(Arc::clone(&run.cancel))
    }

    /// The run's scope as a set, for the list tool.
    pub fn scope(&self, run_id: &str) -> Result<BTreeSet<String>, AgentError> {
        let runs = self.runs.lock().expect("agent run table poisoned");
        let run = runs.get(run_id).ok_or(AgentError::NoSuchRun)?;
        Ok(run.note_ids.clone())
    }

    /// The run as the frontend sees it.
    pub fn view(&self, run_id: &str) -> Result<AgentRunView, AgentError> {
        let runs = self.runs.lock().expect("agent run table poisoned");
        let run = runs.get(run_id).ok_or(AgentError::NoSuchRun)?;
        Ok(AgentRunView {
            run_id: run_id.to_string(),
            scope_total: run.note_ids.len(),
            user_grants: run.user_grants,
            model_grants: run.model_grants,
            cancelled: run.cancel.load(Ordering::SeqCst),
        })
    }

    /// Cancel one run. Returns whether a run with that id existed.
    pub fn cancel(&self, run_id: &str) -> bool {
        let runs = self.runs.lock().expect("agent run table poisoned");
        match runs.get(run_id) {
            Some(run) => {
                run.cancel.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    pub fn is_cancelled(&self, run_id: &str) -> Result<bool, AgentError> {
        let runs = self.runs.lock().expect("agent run table poisoned");
        let run = runs.get(run_id).ok_or(AgentError::NoSuchRun)?;
        Ok(run.cancel.load(Ordering::SeqCst))
    }

    /// Drop one run.
    ///
    /// **A run deliberately OUTLIVES its loop**, which is why this is not called
    /// when the loop reports `Finished`: the apply reads the run's frozen scope
    /// (`contains_all`) and its writability, and the review screen may apply
    /// several times, per edit or in bulk. Ending it at `Finished` would make
    /// the approval that follows fail with `NoSuchRun`.
    ///
    /// The terminal events are therefore **cancel-observed** and **vault lock**,
    /// and both call this or `clear()`. What it costs is that a finished run's
    /// scope stays in RAM for the rest of the unlocked session, which is what
    /// [`Self::start`]'s cap bounds; the host session holding the transcript and
    /// the proposal is dropped on the same events.
    pub fn end(&self, run_id: &str) {
        let mut runs = self.runs.lock().expect("agent run table poisoned");
        runs.remove(run_id);
    }

    /// Cancel and drop **every** run. The vault-lock teardown path.
    ///
    /// Total by requirement, not by convenience: a run holds note ids derived
    /// from decrypted plaintext and a proposal derived from note bodies, and
    /// neither may outlive the unlocked session. The cancel-then-clear order
    /// matters, because a loop already past its cancel check must find the flag
    /// set rather than merely find its run gone.
    pub fn clear(&self) {
        let mut runs = self.runs.lock().expect("agent run table poisoned");
        for run in runs.values() {
            run.cancel.store(true, Ordering::SeqCst);
        }
        runs.clear();
        // The applied record goes with them. It names note ids of a vault that
        // is no longer unlocked, and an undo offered after a lock would target
        // whichever vault is open next. **Its preference VALUES are overwritten
        // first**, because dropping the slot frees them untouched and they are the
        // AS3-class strings `wipe_session` already overwrites elsewhere in this
        // feature (myne-md/myne#850, from the 2026-10-13 review).
        if let Some(record) = self
            .applied
            .lock()
            .expect("agent applied slot poisoned")
            .as_mut()
        {
            record.zeroize_preference_values();
        }
        *self.applied.lock().expect("agent applied slot poisoned") = None;
    }

    /// Record what an apply wrote, under the run that wrote it.
    ///
    /// **MERGES within a run, REPLACES across runs, and the replace branch is
    /// the one that looks like the whole rule.** A second run's apply does
    /// supersede the first: the offer the surface makes is "undo the run you
    /// just applied", and two competing offers is worse than one.
    ///
    /// But one run applies MORE THAN ONCE, and this feature forces it rather
    /// than merely allowing it: [`super::hide::edit_hides_note`] refuses a
    /// removing edit inside an [`Approval::Bulk`], so the user approves that
    /// edit on its own and the same `run_id` arrives here a second time.
    /// Replacing then discarded the first apply's restore points while
    /// `AgentReview` still offered `Undo this run`, so the button reverted the
    /// trailing act and left everything before it standing, reporting success.
    /// Found in the review of myne-md/myne#531.
    ///
    /// **The merge keeps the FIRST point per note and drops later ones**, and
    /// that is the half the first fix got wrong. A run can apply twice to the
    /// SAME note, and the second apply's snapshot is of the note as apply one
    /// left it. Appending both put an intermediate state at the end of a list
    /// `agent_undo` walks in order, so the undo restored the original and then
    /// restored the intermediate ON TOP of it: the note ended up mid-run, the
    /// first apply was not reverted, and `reverted` counted the note twice.
    /// "Undo the run" means back to before the run, so the earliest point is
    /// the only one that answers it. Found in review round five of the same PR,
    /// against the fix for round four.
    ///
    /// [`Approval::Bulk`]: super::apply::Approval::Bulk
    pub fn record_applied(&self, applied: AppliedRun) {
        let mut slot = self.applied.lock().expect("agent applied slot poisoned");
        match slot.as_mut() {
            Some(prev) if prev.run_id == applied.run_id => {
                let known: BTreeSet<&str> = prev
                    .restore_points
                    .iter()
                    .map(|(note_id, _)| note_id.as_str())
                    .collect();
                let fresh: Vec<(String, String)> = applied
                    .restore_points
                    .into_iter()
                    .filter(|(note_id, _)| !known.contains(note_id.as_str()))
                    .collect();
                prev.restore_points.extend(fresh);
                prev.notes_created += applied.notes_created;
                // The same merge, for the same reason, over settings: a run that
                // applies twice and changes one setting both times must leave the
                // EARLIEST previous value, because "undo the run" means back to
                // before the run and not back to the midpoint.
                let known_settings: BTreeSet<&str> =
                    prev.settings.iter().map(|s| s.intent_id.as_str()).collect();
                let fresh_settings: Vec<AppliedSetting> = applied
                    .settings
                    .into_iter()
                    .filter(|s| !known_settings.contains(s.intent_id.as_str()))
                    .collect();
                prev.settings.extend(fresh_settings);
            }
            // **The superseded record is overwritten, not dropped**
            // (myne-md/myne#850, from review): its preference values are the same
            // class as the ones above, and replacing the slot is the ordinary way
            // they leave this struct.
            _ => {
                if let Some(previous) = slot.as_mut() {
                    previous.zeroize_preference_values();
                }
                *slot = Some(applied)
            }
        }
    }

    /// The most recently applied run, if one is still undoable.
    pub fn last_applied(&self) -> Option<AppliedRun> {
        self.applied
            .lock()
            .expect("agent applied slot poisoned")
            .clone()
    }

    /// Take the record for `run_id`, so it can be reverted exactly once.
    ///
    /// Consuming rather than reading is what makes a double undo impossible.
    /// The second call finds nothing and reports [`AgentError::NoSuchRun`]
    /// rather than restoring the same snapshots again, which would look
    /// successful and would silently discard any edit the user made in between.
    pub fn take_applied(&self, run_id: &str) -> Result<AppliedRun, AgentError> {
        let mut slot = self.applied.lock().expect("agent applied slot poisoned");
        match slot.as_ref() {
            Some(a) if a.run_id == run_id => Ok(slot.take().expect("checked just above")),
            _ => Err(AgentError::NoSuchRun),
        }
    }

    /// The run ids the table still holds.
    ///
    /// **For a client that keeps its OWN per-run state**, which the desktop
    /// does: `AgentSessionState` holds the task string, a transcript of whole
    /// note bodies and a proposal of anchors copied verbatim out of them, and it
    /// had no bound at all. This table caps at [`MAX_LIVE_RUNS`] and evicts, so
    /// after nine ordinary runs the first run's SESSION stayed resident and
    /// unreachable until the vault locked. The cap bounded a set of note ids and
    /// left the plaintext holder unbounded (myne-md/myne#531 review round six).
    ///
    /// A live SET rather than an evicted list on [`Self::start`]'s return,
    /// because a caller that prunes to this is self-correcting: it does not have
    /// to have caught every eviction, only to ask once in a while. `start` also
    /// has ~20 call sites whose signature would move for no gain.
    pub fn live_ids(&self) -> BTreeSet<String> {
        self.runs
            .lock()
            .expect("agent run table poisoned")
            .keys()
            .cloned()
            .collect()
    }

    /// How many runs are live. For the lock-teardown assertion and nothing else.
    pub fn len(&self) -> usize {
        self.runs.lock().expect("agent run table poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> BTreeSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_started_run_reports_its_initial_scope() {
        let s = AgentRunState::default();
        s.start("r".into(), ids(&["a", "b"]));
        let v = s.view("r").unwrap();
        assert_eq!(v.scope_total, 2);
        assert_eq!(v.user_grants, 1);
        assert_eq!(v.model_grants, 0);
    }

    #[test]
    fn expanding_unions_and_records_who_asked() {
        let s = AgentRunState::default();
        s.start("r".into(), ids(&["a"]));
        assert_eq!(s.expand("r", ids(&["b"]), GrantOrigin::Model).unwrap(), 2);
        let v = s.view("r").unwrap();
        assert_eq!(v.model_grants, 1);
        assert_eq!(v.user_grants, 1);
    }

    #[test]
    fn re_granting_the_same_notes_does_not_inflate_the_total() {
        let s = AgentRunState::default();
        s.start("r".into(), ids(&["a", "b"]));
        assert_eq!(
            s.expand("r", ids(&["a", "b"]), GrantOrigin::User).unwrap(),
            2
        );
    }

    #[test]
    fn contains_is_the_only_scope_question_and_it_answers_no_by_default() {
        let s = AgentRunState::default();
        s.start("r".into(), ids(&["a"]));
        assert!(s.contains("r", "a").unwrap());
        assert!(!s.contains("r", "b").unwrap());
    }

    #[test]
    fn an_unknown_run_is_a_named_error_not_an_empty_scope() {
        let s = AgentRunState::default();
        assert!(matches!(
            s.contains("nope", "a"),
            Err(AgentError::NoSuchRun)
        ));
        assert!(matches!(s.view("nope"), Err(AgentError::NoSuchRun)));
    }

    #[test]
    fn a_cancelled_run_refuses_further_expansion() {
        let s = AgentRunState::default();
        s.start("r".into(), ids(&["a"]));
        s.cancel("r");
        assert!(matches!(
            s.expand("r", ids(&["b"]), GrantOrigin::Model),
            Err(AgentError::Cancelled)
        ));
    }

    // The lock-teardown requirement, asserted on the STATE rather than on a
    // return value: a caller could report success while a run sat in the table.
    #[test]
    fn clear_cancels_every_run_and_leaves_none_behind() {
        let s = AgentRunState::default();
        let a = s.start("a".into(), ids(&["x"]));
        let b = s.start("b".into(), ids(&["y"]));
        s.clear();
        assert!(s.is_empty(), "no run state survives a lock");
        assert!(
            a.load(Ordering::SeqCst),
            "a loop mid-iteration sees the flag"
        );
        assert!(b.load(Ordering::SeqCst));
    }

    // The resumed-leg case. The start-leg test below covers the flag returned by
    // `start`; this one covers the flag a later step has to fetch, which is where
    // a snapshot copy silently made Stop inert.
    #[test]
    fn the_flag_a_resumed_step_fetches_is_the_one_cancel_sets() {
        let s = AgentRunState::default();
        s.start("r".into(), ids(&["a"]));
        let resumed = s.cancel_flag("r").unwrap();
        assert!(!resumed.load(Ordering::SeqCst));
        s.cancel("r");
        assert!(
            resumed.load(Ordering::SeqCst),
            "a resumed leg watches the run's own flag, not a copy of its value"
        );
    }

    #[test]
    fn a_lock_teardown_reaches_a_resumed_steps_flag_too() {
        let s = AgentRunState::default();
        s.start("r".into(), ids(&["a"]));
        let resumed = s.cancel_flag("r").unwrap();
        s.clear();
        assert!(resumed.load(Ordering::SeqCst));
    }

    #[test]
    fn fetching_the_flag_of_an_unknown_run_is_a_named_error() {
        let s = AgentRunState::default();
        assert!(matches!(s.cancel_flag("nope"), Err(AgentError::NoSuchRun)));
    }

    #[test]
    fn the_cancel_flag_handed_out_at_start_is_the_one_cancel_sets() {
        let s = AgentRunState::default();
        let flag = s.start("r".into(), ids(&["a"]));
        assert!(!flag.load(Ordering::SeqCst));
        s.cancel("r");
        assert!(
            flag.load(Ordering::SeqCst),
            "one mechanism: the host's token wraps this same Arc"
        );
    }

    #[test]
    fn a_cancelled_run_is_not_writable() {
        // Stop has to bound the WRITE, not only the model. The apply asked only
        // about scope, and scope does not look at the flag, so a stopped run
        // still applied on a later click.
        let s = AgentRunState::default();
        s.start("r".into(), ids(&["a"]));
        assert!(s.is_writable("r").is_ok());
        s.cancel("r");
        assert!(matches!(s.is_writable("r"), Err(AgentError::Cancelled)));
    }

    #[test]
    fn writability_of_an_unknown_run_is_a_named_error() {
        let s = AgentRunState::default();
        assert!(matches!(s.is_writable("nope"), Err(AgentError::NoSuchRun)));
    }

    #[test]
    fn the_run_table_is_bounded_and_evicts_the_oldest() {
        // A finished run outlives its loop on purpose, and only a vault lock
        // clears the table, so without a cap a long unlocked session keeps every
        // run's frozen scope.
        //
        // **Driven through `new_run_id`, the same generator production uses.**
        // This test used to mint `run-000`, `run-001`, … and say "ids are UUIDv7
        // in production; ordered ids here" — which is a test asserting the
        // property it supplies itself. It passed for the whole time the host was
        // minting v4, and the eviction was picking an arbitrary run.
        let s = AgentRunState::default();
        let mut flags = Vec::new();
        for _ in 0..(MAX_LIVE_RUNS + 2) {
            let id = new_run_id();
            flags.push((id.clone(), s.start(id, ids(&["a"]))));
            // v7's ordering is millisecond-resolution, and this loop is faster
            // than that. Two ids minted inside one millisecond order by their
            // random tail, which is not the property under test.
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert!(
            flags.windows(2).all(|w| w[0].0 < w[1].0),
            "the generator must produce ascending ids, or the eviction below is \
             testing string order rather than age"
        );
        assert_eq!(s.len(), MAX_LIVE_RUNS);
        // The evicted ones are CANCELLED on the way out, so anything still
        // holding a flag stops rather than running against a table it has
        // fallen out of.
        assert!(
            flags[0].1.load(Ordering::SeqCst),
            "the oldest run's flag must be set when it is evicted"
        );
        assert!(matches!(
            s.is_writable(&flags[0].0),
            Err(AgentError::NoSuchRun)
        ));
        assert!(s.is_writable(&flags[MAX_LIVE_RUNS + 1].0).is_ok());
    }

    fn applied(run_id: &str) -> AppliedRun {
        AppliedRun {
            run_id: run_id.to_string(),
            restore_points: vec![("note-a".into(), "snap-1".into())],
            notes_created: 2,
            settings: Vec::new(),
        }
    }

    #[test]
    fn the_applied_record_outlives_the_run_it_belongs_to() {
        // This is the property the review screen could not provide. The run
        // table entry is gone and the record is still there, which is what
        // "undo is reachable after the review screen is dismissed" means once
        // the surface stops being the thing that remembers.
        let s = AgentRunState::default();
        s.start("r".into(), ids(&["note-a"]));
        s.record_applied(applied("r"));
        s.end("r");
        assert_eq!(s.last_applied(), Some(applied("r")));
    }

    #[test]
    fn a_second_apply_of_the_same_run_adds_to_the_record_rather_than_replacing_it() {
        // The removal carve-out FORCES this shape: `edit_hides_note` refuses a
        // trashing edit inside a bulk approval, so the user approves it on its
        // own and the same run applies twice. Replacing lost the first apply's
        // restore points while the screen still offered "Undo this run", so the
        // button reverted the trailing act and reported success.
        let s = AgentRunState::default();
        s.record_applied(AppliedRun {
            run_id: "r".into(),
            restore_points: vec![("note-a".into(), "snap-1".into())],
            notes_created: 1,
            settings: Vec::new(),
        });
        s.record_applied(AppliedRun {
            run_id: "r".into(),
            restore_points: vec![("note-b".into(), "snap-2".into())],
            notes_created: 2,
            settings: Vec::new(),
        });
        let rec = s.take_applied("r").expect("the run is undoable");
        assert_eq!(
            rec.restore_points,
            vec![
                ("note-a".to_string(), "snap-1".to_string()),
                ("note-b".to_string(), "snap-2".to_string())
            ],
            "an undo of this run has to reach BOTH applies, in the order they happened"
        );
        assert_eq!(
            rec.notes_created, 3,
            "created counts sum across the applies"
        );
    }

    #[test]
    fn a_second_apply_to_the_same_note_keeps_only_the_earliest_restore_point() {
        // The direction the round-four fix did not test: its merge case used
        // `note-a` and `note-b`, so nothing exercised two applies to ONE note,
        // and `extend` with no dedup looked correct.
        //
        // Apply one snapshots the note as the run found it. Apply two snapshots
        // it as apply one left it. `agent_undo` walks the list in order, so
        // holding both means restoring the original and then restoring the
        // INTERMEDIATE over it: the note ends up mid-run, apply one is not
        // reverted, and `reverted` reports 2 for one note. "Undo the run" means
        // back to before the run, which only the earliest point answers.
        let s = AgentRunState::default();
        s.record_applied(AppliedRun {
            run_id: "r".into(),
            restore_points: vec![("note-a".into(), "before-the-run".into())],
            notes_created: 0,
            settings: Vec::new(),
        });
        s.record_applied(AppliedRun {
            run_id: "r".into(),
            // Same note, and a second note alongside it, so the test pins that
            // dedup does not also swallow a genuinely new one.
            restore_points: vec![
                ("note-a".into(), "after-apply-one".into()),
                ("note-b".into(), "before-the-run".into()),
            ],
            notes_created: 0,
            settings: Vec::new(),
        });
        let rec = s.take_applied("r").expect("the run is undoable");
        assert_eq!(
            rec.restore_points,
            vec![
                ("note-a".to_string(), "before-the-run".to_string()),
                ("note-b".to_string(), "before-the-run".to_string())
            ],
            "one point per note, the earliest, and the new note still added"
        );
        assert_eq!(
            rec.restore_points
                .iter()
                .filter(|(id, _)| id == "note-a")
                .count(),
            1,
            "restoring note-a twice would leave it at the intermediate state and \
             count it twice in `reverted`"
        );
    }

    #[test]
    fn a_different_run_still_supersedes_the_record() {
        // The other direction, and it is the one the merge could have broken:
        // the surface offers "undo the run you just applied", so a second RUN
        // must replace rather than accumulate. Without this, the merge above
        // would happily grow one record across unrelated runs and an undo would
        // revert work the user never asked it to touch.
        let s = AgentRunState::default();
        s.record_applied(applied("r1"));
        s.record_applied(applied("r2"));
        assert!(matches!(s.take_applied("r1"), Err(AgentError::NoSuchRun)));
        let rec = s
            .take_applied("r2")
            .expect("the newest run is the undoable one");
        assert_eq!(
            rec.restore_points.len(),
            1,
            "r1's points must not have come along"
        );
    }

    #[test]
    fn a_run_can_be_undone_once_and_the_second_attempt_is_refused() {
        let s = AgentRunState::default();
        s.record_applied(applied("r"));
        assert_eq!(s.take_applied("r").unwrap(), applied("r"));
        // Not "restores nothing quietly": a second undo that reported success
        // would look like it had reverted something, while in fact it would
        // have discarded whatever the user wrote after the first one.
        assert!(matches!(s.take_applied("r"), Err(AgentError::NoSuchRun)));
    }

    #[test]
    fn undo_targets_the_named_run_and_refuses_any_other() {
        let s = AgentRunState::default();
        s.record_applied(applied("r1"));
        assert!(matches!(s.take_applied("r2"), Err(AgentError::NoSuchRun)));
        // And refusing r2 must not have consumed r1.
        assert_eq!(s.take_applied("r1").unwrap().run_id, "r1");
    }

    #[test]
    fn a_second_apply_supersedes_the_first_rather_than_queueing_behind_it() {
        let s = AgentRunState::default();
        s.record_applied(applied("r1"));
        s.record_applied(applied("r2"));
        assert_eq!(s.last_applied().unwrap().run_id, "r2");
        assert!(matches!(s.take_applied("r1"), Err(AgentError::NoSuchRun)));
    }

    #[test]
    fn lock_teardown_drops_the_applied_record_too() {
        // The record names note ids of the vault that was open. Surviving a
        // lock would offer an undo against whichever vault is unlocked next.
        let s = AgentRunState::default();
        s.record_applied(applied("r"));
        s.clear();
        assert_eq!(s.last_applied(), None);
        assert!(matches!(s.take_applied("r"), Err(AgentError::NoSuchRun)));
    }

    // ---- settings in the applied record (myne-md/myne#850) -----------------

    fn applied_setting(run_id: &str, intent: &str, previous: Option<&str>) -> AppliedRun {
        AppliedRun {
            run_id: run_id.to_string(),
            restore_points: Vec::new(),
            notes_created: 0,
            settings: vec![AppliedSetting {
                intent_id: intent.to_string(),
                previous: previous.map(str::to_string),
                previous_folder: None,
            }],
        }
    }

    /// A setting joins the record, so the undo has a value to put back.
    #[test]
    fn a_setting_is_recorded_with_the_value_it_replaced() {
        let s = AgentRunState::default();
        s.record_applied(applied_setting(
            "r",
            "editor.weekly-notes-folder",
            Some("Old/"),
        ));
        let rec = s.take_applied("r").expect("the run is undoable");
        assert_eq!(rec.settings.len(), 1);
        assert_eq!(rec.settings[0].intent_id, "editor.weekly-notes-folder");
        assert_eq!(rec.settings[0].previous.as_deref(), Some("Old/"));
    }

    /// **The merge keeps the EARLIEST previous value**, which is the settings
    /// half of the restore-point rule: "undo the run" means back to before the
    /// run, not back to the midpoint. A run that changes the same setting twice
    /// would otherwise leave the undo restoring the intermediate value.
    #[test]
    fn a_second_apply_keeps_the_earliest_previous_setting_value() {
        let s = AgentRunState::default();
        s.record_applied(applied_setting(
            "r",
            "editor.weekly-notes-folder",
            Some("Original/"),
        ));
        s.record_applied(applied_setting(
            "r",
            "editor.weekly-notes-folder",
            Some("Mid/"),
        ));
        let rec = s.take_applied("r").expect("the run is undoable");
        assert_eq!(rec.settings.len(), 1, "one setting, not two");
        assert_eq!(
            rec.settings[0].previous.as_deref(),
            Some("Original/"),
            "the earliest value is the one undo restores"
        );
    }

    /// A second apply that changes a DIFFERENT setting adds it, which is the
    /// direction the dedup must not swallow.
    #[test]
    fn a_second_apply_adds_a_genuinely_different_setting() {
        let s = AgentRunState::default();
        s.record_applied(applied_setting(
            "r",
            "editor.weekly-notes-folder",
            Some("Original/"),
        ));
        s.record_applied(applied_setting("r", "files.new-note-location", None));
        let rec = s.take_applied("r").expect("the run is undoable");
        assert_eq!(rec.settings.len(), 2);
        assert!(rec
            .settings
            .iter()
            .any(|s| s.intent_id == "files.new-note-location" && s.previous.is_none()));
    }

    /// Settings merge independently of restore points: a run whose second apply
    /// was settings-only must not lose the note restore points from the first.
    #[test]
    fn settings_and_restore_points_merge_independently() {
        let s = AgentRunState::default();
        s.record_applied(applied("r"));
        s.record_applied(applied_setting(
            "r",
            "editor.weekly-notes-folder",
            Some("Original/"),
        ));
        let rec = s.take_applied("r").expect("the run is undoable");
        assert_eq!(rec.restore_points.len(), 1, "the note point survives");
        assert_eq!(rec.settings.len(), 1);
    }

    /// **The preference values are overwritten, and this is the only thing that
    /// says so.** Both discard sites (`clear`, and the replace arm of
    /// `record_applied`) call this, and a version whose body was emptied leaves
    /// every other test in this file green: no assertion elsewhere reads a
    /// value after a discard. The class is AS3 vault structure the model wrote
    /// (myne-md/myne#850, from the 2026-10-13 review).
    #[test]
    fn the_record_overwrites_the_preference_values_it_holds() {
        let mut rec = AppliedRun {
            run_id: "r".to_string(),
            restore_points: Vec::new(),
            notes_created: 0,
            settings: vec![
                AppliedSetting {
                    intent_id: "editor.weekly-notes-folder".to_string(),
                    previous: Some("Old/".to_string()),
                    previous_folder: None,
                },
                AppliedSetting {
                    intent_id: "files.new-note-location".to_string(),
                    previous: Some("specific".to_string()),
                    previous_folder: Some("Old/".to_string()),
                },
                AppliedSetting {
                    intent_id: "editor.daily-notes-date-format".to_string(),
                    previous: None,
                    previous_folder: None,
                },
            ],
        };
        rec.zeroize_preference_values();
        assert_eq!(rec.settings[0].previous.as_deref(), Some(""));
        assert_eq!(rec.settings[1].previous.as_deref(), Some(""));
        assert_eq!(rec.settings[1].previous_folder.as_deref(), Some(""));
        // A setting that was UNSET stays `None` rather than becoming an empty
        // string, which is the distinction `AppliedSetting::previous` rests on:
        // "put X back" against "clear it again".
        assert!(rec.settings[2].previous.is_none());
        // The identifiers are deliberately NOT overwritten, because the undo
        // re-resolves the pref to write from them.
        assert_eq!(rec.settings[0].intent_id, "editor.weekly-notes-folder");
    }
}
