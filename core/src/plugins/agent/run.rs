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
//! That is stated in `docs/threat-model.md` §7 in those words. A future reader
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
}

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

    /// Drop one finished run.
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
        // whichever vault is open next.
        *self.applied.lock().expect("agent applied slot poisoned") = None;
    }

    /// Record what an apply wrote, under the run that wrote it.
    ///
    /// Replaces whatever was there. A second run's apply supersedes the first:
    /// the offer the surface makes is "undo the run you just applied", and two
    /// competing offers is worse than one.
    pub fn record_applied(&self, applied: AppliedRun) {
        *self.applied.lock().expect("agent applied slot poisoned") = Some(applied);
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

    fn applied(run_id: &str) -> AppliedRun {
        AppliedRun {
            run_id: run_id.to_string(),
            restore_points: vec![("note-a".into(), "snap-1".into())],
            notes_created: 2,
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
}
