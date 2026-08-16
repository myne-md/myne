// SPDX-License-Identifier: AGPL-3.0
//! Applying an approved change set.
//!
//! The order here is the whole module, and it is not negotiable:
//!
//! 1. refuse anything outside the run's scope,
//! 2. read the notes as they are **now**, not as the model saw them,
//! 3. place the anchored edits against that current text,
//! 4. take the run's restore point over every note that would change,
//! 5. and only then write.
//!
//! **Step 4 blocks step 5 when it fails.** The restore point is the only thing
//! that makes an agent edit reversible, and an interface that has told the user
//! "you can undo this whole run" must not then write a change it cannot undo.
//! The snapshot subsystem is best-effort by its own description, so this is a
//! real branch rather than a defensive one.
//!
//! **Step 2 is what closes the sync race**, and it costs nothing extra because
//! anchors are content-addressed: a note something else rewrote between the
//! model reading it and the user approving simply fails to match, and its edits
//! are refused by the ordinary rule from [`super::edit`]. There is no lock, no
//! version check and no agent-specific conflict machinery.
//!
//! The rename path's transactional batch deliberately captures no snapshot, and
//! that stays true: its stated reason is that a rename is a deterministic,
//! mechanically reversible rewrite. An agent edit is neither, so the snapshot is
//! added **here**, at this call site, rather than by changing that path.

use super::edit::{place, ProposedEdit};
use super::error::{AgentError, EditRejection};
use super::prompt::ProposedNote;
use super::run::AgentRunState;
use super::trash::edit_trashes;
use crate::folder_key::{canonical_excluded, folder_matches_excluded};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use zeroize::Zeroizing;

/// One edit that did not land, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedEdit {
    /// Which note it was for.
    pub note_id: String,
    /// Its index in the approved list, so the review screen can mark the row
    /// the user actually looked at rather than guessing by content.
    pub index: usize,
    /// Why it did not land.
    pub reason: EditRejection,
}

/// One proposed new note that did not get created, and why.
///
/// Its own list rather than a `RefusedEdit` with a reused `index`, because the
/// two index spaces are different: a refused edit at index 0 and a refused new
/// note at index 0 are different rows, and the review screen marks the wrong one
/// if they share a field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedNewNote {
    /// Its index in the run's proposed-new-note list.
    pub index: usize,
    /// Why it was not created.
    pub reason: EditRejection,
}

/// What an apply did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    /// How many edits landed.
    pub applied: usize,
    /// Every edit that did not, with its cause.
    pub refused: Vec<RefusedEdit>,
    /// The notes that were written.
    pub notes_written: Vec<String>,
    /// The ids of notes the run created. Separate from `notes_written` because a
    /// create has no restore point: there is nothing to revert to, and undoing
    /// one means trashing it rather than restoring a snapshot.
    pub notes_created: Vec<String>,
    /// Which PROPOSAL INDICES were actually created.
    ///
    /// `#[serde(skip)]`: the surface has no use for it, and widening the IPC
    /// payload for a host-side bookkeeping value would be the wrong trade. The
    /// host needs it to drop exactly the notes that landed from the session's
    /// recorded proposal, so a failed or partly-refused apply stays retryable.
    /// Deriving it as "asked minus refused" would be a second copy of a rule
    /// this function already owns, and a copy that drifts is worse than none.
    #[serde(skip)]
    pub created_new_note_indices: Vec<usize>,
    /// Proposed new notes that were not created, with their causes.
    pub refused_new_notes: Vec<RefusedNewNote>,
    /// `(note_id, snapshot_id)` for every note this apply wrote, so the whole
    /// run reverts as one action. Empty when nothing was written.
    pub restore_points: Vec<(String, String)>,
}

/// Reading a note's current body at apply time.
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait ApplyReader: Send + Sync {
    async fn current_body(&self, note_id: &str) -> Result<String, AgentError>;
}

/// Taking the run's restore point.
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait RestorePointTaker: Send + Sync {
    /// Capture every named note, and return what was captured.
    ///
    /// The return value is the record, not a receipt: `(note_id, snapshot_id)`
    /// per note, which is what "revert this whole run as one action" actually
    /// needs. An earlier shape returned the run id and left the real list in a
    /// side-channel the caller read afterwards, which meant this trait's own
    /// contract could not be held to by a test.
    ///
    /// An `Err` here **stops the apply**. Implementations must not swallow a
    /// failure into an `Ok`: a best-effort snapshot reported as success is the
    /// exact shape this contract exists to forbid.
    async fn capture(
        &self,
        run_id: &str,
        note_ids: &[String],
    ) -> Result<Vec<(String, String)>, AgentError>;
}

/// Writing the changed notes, transactionally.
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait BatchWriter: Send + Sync {
    async fn write_batch(&self, notes: Vec<(String, String)>) -> Result<(), AgentError>;

    /// Create one note and return its id.
    ///
    /// Separate from [`Self::write_batch`] because a create is not a rewrite:
    /// there is no existing blob and therefore no restore point to take, and the
    /// transactional batch is defined over notes that already exist.
    async fn create_note(&self, note: &ProposedNote) -> Result<String, AgentError>;
}

/// How the user approved this batch.
///
/// **This is the trash carve-out, and it is here rather than in the UI on
/// purpose.** Trashing a note is a `trashed:` frontmatter timestamp, so at the
/// diff layer it is indistinguishable from any other edit; the rule that a bulk
/// approve may not carry one is therefore a rule about *what the user did*, not
/// about what the edit looks like. Expressed as a component-level filter it is
/// only ever as true as the current component: a second caller, a refactor, or
/// the mobile port would each have to re-derive it, and the host could not
/// detect the mistake afterwards. Expressed here it is a property of the one
/// place a write happens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Approval {
    /// One edit the user approved on its own. May trash a note.
    Individual,
    /// A batch the user approved in one action. **May not trash a note.** An
    /// edit that would is refused with [`EditRejection::TrashNeedsOwnAct`],
    /// reported like any other refusal, and the rest of the batch still applies.
    Bulk,
}

/// Apply the edits the user approved.
#[allow(clippy::too_many_arguments)]
pub async fn apply_approved(
    runs: &AgentRunState,
    run_id: &str,
    approved: &[ProposedEdit],
    // `approved_new_notes` is the new notes the user approved, each with its
    // index in the run's proposed list. A SELECTION, not the whole proposal: a
    // create is a write, and SYNC-17's restatement says no write happens without
    // a per-note approval. Handing this the run's whole list is the defect the
    // parameter shape exists to make visible at every call site.
    approved_new_notes: &[(usize, ProposedNote)],
    excluded_folders: &[String],
    approval: Approval,
    reader: &dyn ApplyReader,
    restore: &dyn RestorePointTaker,
    writer: &dyn BatchWriter,
) -> Result<ApplyOutcome, AgentError> {
    let mut outcome = ApplyOutcome::default();

    // 1. Scope, first, and by note rather than in a later loop: an out-of-scope
    //    note must not even be read. Classified in one pass under one lock,
    //    rather than one lock and one run lookup per edit.
    let ids: Vec<String> = approved.iter().map(|e| e.note_id.clone()).collect();
    let allowed = runs.contains_all(run_id, &ids)?;
    let mut in_scope: Vec<(usize, &ProposedEdit)> = Vec::new();
    for ((index, edit), keep) in approved.iter().enumerate().zip(allowed) {
        if keep {
            in_scope.push((index, edit));
        } else {
            outcome.refused.push(RefusedEdit {
                note_id: edit.note_id.clone(),
                index,
                reason: EditRejection::OutOfScope,
            });
        }
    }

    // 2. Read current bodies, once per note.
    //
    // `Zeroizing` because these are whole note bodies held across several awaits
    // and, on a large batch, across every placement in step 3. `threat-model.md`
    // §7 requires AI-path plaintext to be `Zeroizing`-scoped in RAM, and this map
    // is the largest such holder in the feature.
    let mut bodies: BTreeMap<String, Zeroizing<String>> = BTreeMap::new();
    let mut unreadable: BTreeSet<String> = BTreeSet::new();
    for (_, edit) in &in_scope {
        if bodies.contains_key(&edit.note_id) || unreadable.contains(&edit.note_id) {
            continue;
        }
        // A note deleted or corrupted between the proposal and the approval is
        // the same drift step 2 exists to absorb, so it refuses ONE note rather
        // than the batch. Propagating here would discard edits already placed
        // for other notes and skip the restore point entirely.
        match reader.current_body(&edit.note_id).await {
            Ok(body) => {
                bodies.insert(edit.note_id.clone(), Zeroizing::new(body));
            }
            Err(_) => {
                unreadable.insert(edit.note_id.clone());
            }
        }
    }
    for (index, edit) in &in_scope {
        if unreadable.contains(&edit.note_id) {
            outcome.refused.push(RefusedEdit {
                note_id: edit.note_id.clone(),
                index: *index,
                reason: EditRejection::ReadFailed,
            });
        }
    }

    // 3. Place, sequentially per note against the running body. Notes whose edits
    //    actually landed are recorded as they land, rather than by diffing
    //    against a copy of every body taken beforehand: the copy answered the
    //    same question and cost a full duplicate of every in-scope note's text.
    let mut touched: BTreeSet<String> = BTreeSet::new();
    for (index, edit) in &in_scope {
        let Some(body) = bodies.get(&edit.note_id) else {
            continue; // already refused above as unreadable
        };
        match place(body, &edit.anchor, &edit.replacement) {
            Ok(next) => {
                // The carve-out, checked on the RESULT rather than on the edit's
                // text: whether a note ends up trashed is a fact about the note
                // after the edit, and reading it here means the host never has
                // to agree with the frontend about what a trash looks like.
                if approval == Approval::Bulk && edit_trashes(body, &next) {
                    outcome.refused.push(RefusedEdit {
                        note_id: edit.note_id.clone(),
                        index: *index,
                        reason: EditRejection::TrashNeedsOwnAct,
                    });
                    continue;
                }
                bodies.insert(edit.note_id.clone(), Zeroizing::new(next));
                touched.insert(edit.note_id.clone());
                outcome.applied += 1;
            }
            Err(reason) => outcome.refused.push(RefusedEdit {
                note_id: edit.note_id.clone(),
                index: *index,
                reason,
            }),
        }
    }

    // Only notes that actually changed get written. A note whose every edit was
    // refused must not be rewritten with identical bytes: that would bump its
    // sync version and its mtime for no change.
    // The wrapper is unwrapped only here, at the boundary where the bytes are
    // handed to the writer that will encrypt them.
    let changed: Vec<(String, String)> = bodies
        .into_iter()
        .filter(|(id, _)| touched.contains(id))
        .map(|(id, body)| (id, body.to_string()))
        .collect();

    // Nothing to rewrite is NOT nothing to do: a run may propose only new notes,
    // and an early return here would have skipped the create pass entirely. It
    // did, until the creation tests caught it.
    if !changed.is_empty() {
        // 4. Restore point BEFORE the write, and a failure here ends the apply.
        let note_ids: Vec<String> = changed.iter().map(|(id, _)| id.clone()).collect();
        outcome.restore_points = restore.capture(run_id, &note_ids).await?;

        // 5. Write.
        writer.write_batch(changed).await?;
        outcome.notes_written = note_ids;
    }

    // 6. Create. Last, and after the restore point, so a create is never the
    //    thing that leaves a half-applied batch.
    create_notes(approved_new_notes, excluded_folders, writer, &mut outcome).await?;
    Ok(outcome)
}

/// Create the approved new notes.
///
/// **The excluded-folder clamp applies here too, and that is the point of this
/// function existing rather than the create being inlined above.** A new note's
/// folder comes from the model, so it is the one place a write can name a
/// destination the user never approved. The scope clamp cannot cover it: a note
/// that does not exist yet is in no scope, so the content control is what
/// applies, exactly as it does to every read.
///
/// Still returns `Result` although every per-note failure is now a refusal:
/// the shape leaves room for a failure that genuinely should stop the apply,
/// and collapsing it to `()` would have to be undone to add one.
///
/// Runs after the edits, and after the restore point, so a create can never be
/// the thing that leaves a half-applied batch: by the time it runs, every edit
/// has already landed or been refused.
async fn create_notes(
    new_notes: &[(usize, ProposedNote)],
    excluded_folders: &[String],
    writer: &dyn BatchWriter,
    outcome: &mut ApplyOutcome,
) -> Result<(), AgentError> {
    if new_notes.is_empty() {
        return Ok(());
    }
    let excluded = canonical_excluded(excluded_folders);
    for (index, note) in new_notes {
        // Two refusals, and the second is the one a model-supplied string could
        // otherwise walk around. `folder_matches_excluded` tests the FIELD; a
        // title carrying a newline can emit a second `folder:` line the clamp
        // never saw, so the fields are validated for shape first.
        if !frontmatter_safe(&note.title) || !note.folder.as_deref().is_none_or(frontmatter_safe) {
            outcome.refused_new_notes.push(RefusedNewNote {
                index: *index,
                reason: EditRejection::UnsafeFrontmatter,
            });
            continue;
        }
        let folder = note.folder.as_deref().unwrap_or("");
        if folder_matches_excluded(folder, &excluded) {
            outcome.refused_new_notes.push(RefusedNewNote {
                index: *index,
                reason: EditRejection::ExcludedFolder,
            });
            continue;
        }
        // NOT `?`. A create runs after the edit batch has been committed and
        // after the restore point was taken, so propagating here discards the
        // outcome those two steps produced: the run's edits stay on disk, the
        // caller never records an undo record for them, and the surface reports
        // that the changes could not be applied while they in fact were. The
        // failed create becomes a refusal like any other, and the rest of the
        // batch keeps its undo.
        match writer.create_note(note).await {
            Ok(id) => {
                outcome.notes_created.push(id);
                outcome.created_new_note_indices.push(*index);
            }
            Err(_) => outcome.refused_new_notes.push(RefusedNewNote {
                index: *index,
                reason: EditRejection::CreateFailed,
            }),
        }
    }
    Ok(())
}

/// Whether a value can go into a frontmatter field without escaping the field.
///
/// A `title` of `T\nfolder: Private` emits a `folder:` line nothing checked; a
/// `\n---\n` closes the block early; `\ntrashed: <ts>` and `\ntemplate: true`
/// are reachable the same way. The value comes from the model, so this is
/// checked in core rather than left to whichever host does the serializing.
fn frontmatter_safe(value: &str) -> bool {
    !value.contains('\n') && !value.contains('\r')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::block_on;
    use std::collections::BTreeSet;
    use std::sync::Mutex;

    fn ids(v: &[&str]) -> BTreeSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn edit(note: &str, anchor: &str, replacement: &str) -> ProposedEdit {
        ProposedEdit {
            note_id: note.into(),
            anchor: anchor.into(),
            replacement: replacement.into(),
        }
    }

    /// Stands in for the disk. The point of walking it in the assertions rather
    /// than reading a return value is that a return value can say "refused"
    /// while the bytes changed anyway.
    #[derive(Default)]
    struct Disk {
        notes: Mutex<BTreeMap<String, String>>,
        restore_ok: bool,
        captured: Mutex<Vec<(String, Vec<String>)>>,
        /// Make `create_note` fail. Off by default, so every existing test is
        /// unaffected and the one that sets it says why it does.
        create_fails: bool,
    }

    impl Disk {
        fn with(pairs: &[(&str, &str)], restore_ok: bool) -> Self {
            Self {
                notes: Mutex::new(
                    pairs
                        .iter()
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                        .collect(),
                ),
                restore_ok,
                captured: Mutex::new(Vec::new()),
                create_fails: false,
            }
        }
        fn failing_creates(pairs: &[(&str, &str)]) -> Self {
            let mut d = Self::with(pairs, true);
            d.create_fails = true;
            d
        }
        fn read_back(&self, id: &str) -> String {
            self.notes
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .unwrap_or_default()
        }
    }

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl ApplyReader for Disk {
        async fn current_body(&self, note_id: &str) -> Result<String, AgentError> {
            Ok(self.read_back(note_id))
        }
    }

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl RestorePointTaker for Disk {
        async fn capture(
            &self,
            run_id: &str,
            note_ids: &[String],
        ) -> Result<Vec<(String, String)>, AgentError> {
            if !self.restore_ok {
                return Err(AgentError::RestorePointFailed);
            }
            self.captured
                .lock()
                .unwrap()
                .push((run_id.to_string(), note_ids.to_vec()));
            Ok(note_ids
                .iter()
                .map(|id| (id.clone(), format!("snap-{id}")))
                .collect())
        }
    }

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl BatchWriter for Disk {
        async fn write_batch(&self, notes: Vec<(String, String)>) -> Result<(), AgentError> {
            let mut m = self.notes.lock().unwrap();
            for (id, body) in notes {
                m.insert(id, body);
            }
            Ok(())
        }

        async fn create_note(&self, note: &ProposedNote) -> Result<String, AgentError> {
            if self.create_fails {
                return Err(AgentError::WriteFailed);
            }
            let id = format!("new-{}", note.title);
            self.notes
                .lock()
                .unwrap()
                .insert(id.clone(), note.body.clone());
            Ok(id)
        }
    }

    #[test]
    fn an_approved_edit_lands_and_the_restore_point_covers_it() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", "hello world")], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "world", "there")],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 1);
        assert_eq!(disk.read_back("a"), "hello there");
        let cap = disk.captured.lock().unwrap().clone();
        assert_eq!(cap.len(), 1);
        assert_eq!(cap[0].0, "r");
        assert_eq!(cap[0].1, vec!["a".to_string()]);
    }

    // The load-bearing one. Asserted by reading the notes back off the stand-in
    // disk, not by trusting the returned error: a function can report a failure
    // while the change already sat on the medium.
    #[test]
    fn a_failed_restore_point_blocks_the_write_verified_on_the_disk() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", "hello world")], false);
        let err = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "world", "there")],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap_err();
        assert!(matches!(err, AgentError::RestorePointFailed));
        assert_eq!(
            disk.read_back("a"),
            "hello world",
            "the note is byte-identical; nothing was written"
        );
    }

    #[test]
    fn the_restore_point_is_taken_before_the_write_not_after() {
        // Ordering, expressed as a fact rather than as a comment: with the
        // capture failing, no write can have happened, which is only true if
        // capture precedes write.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let disk = Disk::with(&[("a", "x"), ("b", "y")], false);
        let _ = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "x", "1"), edit("b", "y", "2")],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ));
        assert_eq!(disk.read_back("a"), "x");
        assert_eq!(disk.read_back("b"), "y");
    }

    #[test]
    fn a_note_that_moved_under_a_pending_review_is_refused_not_misapplied() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        // The model read "alpha beta gamma"; sync landed a different body.
        let disk = Disk::with(&[("a", "alpha BETA gamma")], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "beta", "delta")],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 0);
        assert_eq!(out.refused.len(), 1);
        assert_eq!(out.refused[0].reason, EditRejection::AnchorNotFound);
        assert_eq!(disk.read_back("a"), "alpha BETA gamma");
    }

    #[test]
    fn out_of_scope_edits_are_refused_by_name_and_never_read() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", "x"), ("b", "y")], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit("b", "y", "z")],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.refused.len(), 1);
        assert_eq!(out.refused[0].reason, EditRejection::OutOfScope);
        assert_eq!(disk.read_back("b"), "y");
    }

    #[test]
    fn a_partial_apply_reports_both_counts_with_a_cause_per_refusal() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", "one two")], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "one", "1"), edit("a", "zzz", "9")],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 1);
        assert_eq!(out.refused.len(), 1);
        assert_eq!(out.refused[0].index, 1);
        assert_eq!(out.refused[0].reason, EditRejection::AnchorNotFound);
        assert_eq!(disk.read_back("a"), "1 two");
    }

    #[test]
    fn a_note_whose_every_edit_was_refused_is_not_rewritten_at_all() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", "unchanged")], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "nope", "x")],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert!(out.notes_written.is_empty());
        assert!(
            out.restore_points.is_empty(),
            "no write, so no restore point was taken"
        );
        assert!(disk.captured.lock().unwrap().is_empty());
    }

    const TRASH_TS: &str = "2026-08-16T10:00:00Z";

    fn note_with(fm: &str) -> String {
        format!("---\n{fm}\n---\n\nbody\n")
    }

    // The carve-out, asserted on the DISK rather than on the returned error: a
    // host that reported the refusal and wrote anyway would pass a return-value
    // assertion. This is also the test that would have caught the shipped
    // version, in which the rule lived only in the React component and
    // `apply_approved` wrote whatever list it was handed.
    #[test]
    fn a_bulk_approval_cannot_trash_a_note_and_the_note_is_unchanged() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let before = note_with("title: T");
        let disk = Disk::with(&[("a", &before)], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit(
                "a",
                "title: T",
                &format!("title: T\ntrashed: {TRASH_TS}"),
            )],
            &[],
            &[],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 0);
        assert_eq!(out.refused.len(), 1);
        assert_eq!(out.refused[0].reason, EditRejection::TrashNeedsOwnAct);
        assert_eq!(disk.read_back("a"), before, "the note is byte-identical");
    }

    #[test]
    fn the_same_edit_applies_when_the_user_approved_it_on_its_own() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", &note_with("title: T"))], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit(
                "a",
                "title: T",
                &format!("title: T\ntrashed: {TRASH_TS}"),
            )],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 1);
        assert!(disk.read_back("a").contains("trashed:"));
    }

    #[test]
    fn a_refused_trash_does_not_stop_the_rest_of_the_batch() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let disk = Disk::with(&[("a", &note_with("title: T")), ("b", "keep me")], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[
                edit("a", "title: T", &format!("title: T\ntrashed: {TRASH_TS}")),
                edit("b", "keep me", "kept"),
            ],
            &[],
            &[],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 1);
        assert_eq!(out.refused.len(), 1);
        assert_eq!(disk.read_back("b"), "kept");
    }

    // The direction a fix aimed at the new case is most likely to break: the
    // strict reader is value-strict, so a user's own non-timestamp `trashed:`
    // must NOT be treated as a trash and must still apply inside a bulk.
    #[test]
    fn a_users_own_non_timestamp_trashed_value_still_applies_in_a_bulk() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", &note_with("title: T"))], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "title: T", "title: T\ntrashed: true")],
            &[],
            &[],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 1);
    }

    // The sequential-overlap semantics, tested on the loop that runs. They used
    // to live on a public `apply_all` in `edit.rs` that production never called,
    // so what was pinned was a second implementation of the same rule.
    #[test]
    fn edits_apply_sequentially_against_the_running_body() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", "one two three")], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "one", "1"), edit("a", "three", "3")],
            &[],
            &[],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 2);
        assert_eq!(disk.read_back("a"), "1 two 3");
    }

    #[test]
    fn an_edit_whose_anchor_a_previous_edit_destroyed_is_refused_not_misapplied() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", "hello world")], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "world", "there"), edit("a", "world", "X")],
            &[],
            &[],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 1);
        assert_eq!(out.refused.len(), 1);
        assert_eq!(out.refused[0].reason, EditRejection::AnchorNotFound);
        assert_eq!(disk.read_back("a"), "hello there");
    }

    #[test]
    fn a_refused_edit_does_not_stop_the_ones_after_it() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", "a b c")], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "zzz", "X"), edit("a", "c", "C")],
            &[],
            &[],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 1);
        assert_eq!(disk.read_back("a"), "a b C");
    }

    #[test]
    fn a_refusal_carries_the_index_of_the_row_the_user_looked_at() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", "a b c")], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[
                edit("a", "a", "A"),
                edit("a", "zzz", "X"),
                edit("a", "c", "C"),
            ],
            &[],
            &[],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.refused.len(), 1);
        assert_eq!(out.refused[0].index, 1);
    }

    /// A create that fails AFTER the edit batch was written must not take the
    /// run's undo record with it.
    ///
    /// This is asserted on the returned outcome AND on the disk, because the
    /// two can disagree in exactly the direction that matters: the earlier
    /// version propagated the error, so the caller saw `Err` (and told the user
    /// "the changes could not be applied") while the edit sat on the medium
    /// with no restore point recorded anywhere.
    #[test]
    fn a_failed_create_keeps_the_applied_edits_undoable() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::failing_creates(&[("a", "hello world")]);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "world", "there")],
            &[(0, new_note("New", None))],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .expect("a failed create is a refusal, not an apply failure");

        // The edit landed, and the state says so rather than the return value
        // alone.
        assert_eq!(out.applied, 1);
        assert_eq!(disk.read_back("a"), "hello there");

        // And it is still undoable: the restore point survived the create.
        assert_eq!(out.restore_points.len(), 1);
        assert_eq!(out.restore_points[0].0, "a");
        assert_eq!(out.notes_written, vec!["a".to_string()]);

        // The create is reported by name rather than swallowed.
        assert!(out.notes_created.is_empty());
        assert_eq!(out.refused_new_notes.len(), 1);
        assert_eq!(out.refused_new_notes[0].index, 0);
        assert_eq!(out.refused_new_notes[0].reason, EditRejection::CreateFailed);
    }

    fn new_note(title: &str, folder: Option<&str>) -> ProposedNote {
        ProposedNote {
            title: title.into(),
            body: "body".into(),
            folder: folder.map(str::to_string),
        }
    }

    #[test]
    fn an_approved_new_note_is_created_and_reported() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[],
            &[(0, new_note("Fresh", Some("Projects")))],
            &[],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.notes_created, vec!["new-Fresh".to_string()]);
        assert_eq!(disk.read_back("new-Fresh"), "body");
    }

    // The clamp the scope model cannot cover: a note that does not exist yet is
    // in no scope, so the CONTENT control is what applies. Asserted on the disk,
    // because a version that reported the refusal and created it anyway would
    // pass a return-value assertion.
    #[test]
    fn a_new_note_in_an_excluded_folder_is_refused_and_never_created() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[],
            &[(0, new_note("Secret", Some("Private/Deep")))],
            &["Private".into()],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert!(out.notes_created.is_empty());
        assert_eq!(out.refused_new_notes.len(), 1);
        assert_eq!(
            out.refused_new_notes[0].reason,
            EditRejection::ExcludedFolder
        );
        assert_eq!(disk.read_back("new-Secret"), "", "nothing was created");
    }

    #[test]
    fn a_refused_new_note_does_not_stop_the_others() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[],
            &[
                (0, new_note("Secret", Some("Private"))),
                (1, new_note("Fine", Some("Projects"))),
            ],
            &["Private".into()],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.notes_created, vec!["new-Fine".to_string()]);
        assert_eq!(out.refused_new_notes.len(), 1);
        assert_eq!(
            out.refused_new_notes[0].index, 0,
            "the refusal names ITS own row"
        );
    }

    // The frontmatter-shape check, which is the half a folder-only clamp misses.
    #[test]
    fn a_new_note_whose_title_smuggles_a_folder_line_is_refused() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[],
            &[(0, new_note("T\nfolder: Private", Some("Public")))],
            &["Private".into()],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert!(out.notes_created.is_empty());
        assert_eq!(
            out.refused_new_notes[0].reason,
            EditRejection::UnsafeFrontmatter
        );
    }

    #[test]
    fn a_new_note_whose_title_closes_the_frontmatter_block_is_refused() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[],
            &[(0, new_note("T\n---\ntrashed: 2026-08-16T10:00:00Z", None))],
            &[],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert!(out.notes_created.is_empty());
    }

    // A note the user did NOT approve is simply not in the list, so it cannot be
    // created. Stated as a test because the defect this replaced was exactly a
    // caller handing over the whole proposal.
    #[test]
    fn only_the_selected_new_notes_are_created() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[],
            &[(1, new_note("Chosen", None))],
            &[],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.notes_created, vec!["new-Chosen".to_string()]);
        assert_eq!(disk.read_back("new-Unchosen"), "");
    }

    #[test]
    fn a_new_note_at_the_vault_root_is_not_caught_by_a_real_exclusion() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[],
            &[(0, new_note("Root", None))],
            &["Private".into()],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.notes_created.len(), 1);
    }

    #[test]
    fn several_notes_share_one_restore_point_so_the_run_reverts_as_one() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let disk = Disk::with(&[("a", "x"), ("b", "y")], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "x", "1"), edit("b", "y", "2")],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.notes_written.len(), 2);
        let cap = disk.captured.lock().unwrap().clone();
        assert_eq!(cap.len(), 1, "one capture call, not one per note");
        assert_eq!(cap[0].1.len(), 2);
        // The record travels back through the outcome, so "revert this run" has
        // one place to read rather than a side-channel to be read in the right
        // order.
        assert_eq!(out.restore_points.len(), 2);
        assert!(out
            .restore_points
            .iter()
            .all(|(_, s)| s.starts_with("snap-")));
    }
}
