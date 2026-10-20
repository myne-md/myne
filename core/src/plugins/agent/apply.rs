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

use super::edit::{apply_edit, EditKind, ProposedEdit};
use super::error::{AgentError, EditRejection};
use super::frontmatter::{edit_moves_note, folder_of};
use super::hide::edit_hides_note;
use super::prompt::ProposedNote;
use super::prompt::ProposedSetting;
use super::run::{AgentRunState, AppliedSetting};
use super::setting::SettingIntent;
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
    /// Setting changes that landed, with the value each replaced
    /// (myne-md/myne#850). Carried on this outcome rather than on a second
    /// reply type because the surface that renders them is the one that renders
    /// everything else an apply did, and two replies would be two things to keep
    /// in step.
    pub settings_changed: Vec<AppliedSetting>,
    /// Setting changes that did not land, with their causes.
    pub refused_settings: Vec<RefusedSetting>,
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

/// One note's write in a batch: the text, and the text it was derived from.
///
/// **`base` is the merge base, and it exists because a note can be someone
/// else's too** (myne-md/myne#849 review, myne-md/myne#893 follow-up). An apply
/// reads each note from disk, places the edits against that read and writes the
/// result. On a live-collaboration vault a peer's change may be merged into the
/// session between the read and this write, and a write that does not say what
/// it read REPLACES that change rather than merging over it. `None` means the
/// write is deliberately a replacement (a snapshot restore), which is a
/// decision the caller states rather than one the writer infers.
pub struct BatchWrite {
    pub note_id: String,
    pub text: String,
    /// The body `text` was derived from, or `None` for an intentional replace.
    pub base: Option<String>,
}

/// Writing the changed notes, transactionally.
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait BatchWriter: Send + Sync {
    async fn write_batch(&self, notes: Vec<BatchWrite>) -> Result<(), AgentError>;

    /// Create one note and return its id.
    ///
    /// Separate from [`Self::write_batch`] because a create is not a rewrite:
    /// there is no existing blob and therefore no restore point to take, and the
    /// transactional batch is defined over notes that already exist.
    async fn create_note(&self, note: &ProposedNote) -> Result<String, AgentError>;
}

/// How the user approved this batch.
///
/// **This is the removal carve-out, and it is here rather than in the UI on
/// purpose.** Every way Myne takes a note out of the working set is a
/// frontmatter field (`trashed:`, `deleted:`, `archived:`, `template:`,
/// `conflict:` — [`super::hide::edit_hides_note`] carries the roster), so at
/// the diff layer a removal is indistinguishable from any other edit; the rule
/// that a bulk approve may not carry one is therefore a rule about *what the
/// user did*, not
/// about what the edit looks like. Expressed as a component-level filter it is
/// only ever as true as the current component: a second caller, a refactor, or
/// the mobile port would each have to re-derive it, and the host could not
/// detect the mistake afterwards. Expressed here it is a property of the one
/// place a write happens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Approval {
    /// One edit the user approved on its own. May remove a note from the
    /// working set.
    Individual,
    /// A batch the user approved in one action. **May not remove a note from
    /// the working set.** An edit that would is refused with
    /// [`EditRejection::RemovalNeedsOwnAct`], reported like any other refusal,
    /// and the rest of the batch still applies.
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

    // 0. The approval LABEL is bounded before anything else is, because the
    //    removal carve-out in step 3 is the only reader of it and fires only on
    //    `Bulk`. Without this, an approve-all relabelled `individual` carried
    //    forty edits — a `deleted:` tombstone among them — past a control whose
    //    predicate is host-side and whose trigger was the caller's. That is the
    //    shape `threat-model.md` §7 and `decisions/ai/0515` both contrast with a
    //    frontend filter, so it had to hold here or the claim was false
    //    (myne-md/myne#531 review round six).
    //
    //    Here rather than in the IPC wrapper: this is the function every client
    //    calls, and a desktop-side check would be one the mobile port has to
    //    re-derive, which is the same shape one layer up.
    if approval == Approval::Individual && approved.len() + approved_new_notes.len() > 1 {
        return Err(AgentError::IndividualApprovalNotSingle);
    }

    // 1. Scope, first, and by note rather than in a later loop: an out-of-scope
    //    note must not even be read. Classified in one pass under one lock,
    //    rather than one lock and one run lookup per edit.
    let ids: Vec<String> = approved.iter().map(|e| e.note_id.clone()).collect();
    // Stop bounds the WRITE too, not only the model. A run the user stopped kept
    // its proposal and still applied on a later click, because scope membership
    // was the only thing asked and it does not look at the flag. The lock path
    // was safe by accident: `clear()` removes the run, so the flag was never the
    // thing protecting it.
    runs.is_writable(run_id)?;
    let allowed = runs.contains_all(run_id, &ids)?;
    // SYNC-14 has no in-flight carve-out, and the frozen scope is not one.
    // Freezing the GRANT is about what the user approved; an exclusion they add
    // while a run is open or a review is pending is a control they TIGHTENED,
    // and `threat-model.md` §7 states the rule without an exception for work
    // already in flight. The set is re-read at the command boundary for exactly
    // this reason, so the newest answer decides, and it decides for edits as
    // well as for creates.
    let excluded_now = canonical_excluded(excluded_folders);
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
    // The SYNC-14 clamp, on the note as it is NOW. A note's folder lives in its
    // frontmatter, so this is the first point at which it is knowable, and the
    // excluded set was re-read at the command boundary rather than carried from
    // the run, so an exclusion the user added mid-run decides here.
    let mut excluded_note: BTreeSet<String> = BTreeSet::new();
    for id in bodies.keys() {
        let body = &bodies[id];
        // `folder_of` slices the frontmatter BLOCK out first, which is what
        // `fm_folder` expects: passing a whole note found nothing and the clamp
        // silently allowed every edit, and the test asserting an excluded note
        // is refused is what caught it. That failure is why the read has one
        // caller now rather than three copies.
        let folder = folder_of(body);
        if folder_matches_excluded(&folder, &excluded_now) {
            excluded_note.insert(id.clone());
        }
    }
    // Drop their bodies, which is what actually stops the write: step 3 skips a
    // note with no entry here, and that is the same mechanism the unreadable
    // case uses. Recording the refusal alone left the edit in `in_scope`, so it
    // was refused AND applied, which the test caught by reading the disk rather
    // than the outcome.
    for id in &excluded_note {
        bodies.remove(id);
    }
    for (index, edit) in &in_scope {
        if unreadable.contains(&edit.note_id) {
            outcome.refused.push(RefusedEdit {
                note_id: edit.note_id.clone(),
                index: *index,
                reason: EditRejection::ReadFailed,
            });
        } else if excluded_note.contains(&edit.note_id) {
            outcome.refused.push(RefusedEdit {
                note_id: edit.note_id.clone(),
                index: *index,
                reason: EditRejection::ExcludedNow,
            });
        }
    }

    // 3. Place, sequentially per note against the running body. Notes whose edits
    //    actually landed are recorded as they land, rather than by diffing
    //    against a copy of every body taken beforehand: the copy answered the
    //    same question and cost a full duplicate of every in-scope note's text.
    let mut touched: BTreeSet<String> = BTreeSet::new();
    // The pre-image per note, taken ONLY for notes an edit lands on (a whole
    // duplicate of every in-scope body is the cost the comment above records
    // being avoided). This becomes the merge base of the write.
    let mut originals: BTreeMap<String, Zeroizing<String>> = BTreeMap::new();
    for (index, edit) in &in_scope {
        let Some(body) = bodies.get(&edit.note_id) else {
            continue; // already refused above as unreadable
        };
        match apply_edit(body, edit) {
            Ok(next) => {
                // The folder rule, in two arms, and the split is what the move
                // verb bought.
                //
                // An anchored edit may still not move a note, and it is still
                // checked on the RESULT: the SYNC-14 clamp twenty lines up read
                // `folder:` off the note as it stands BEFORE this loop, nothing
                // re-read it afterwards, and the removal roster does not carry
                // the field. This arm refuses under every approval label, because
                // no user act makes an agent-chosen folder move correct while the
                // destination is hidden inside replacement text.
                //
                // The move verb is the opposite case: its destination IS the
                // edit's field, so the same clamp can read where the note lands.
                // That is the whole reason the verb exists rather than the lock
                // being deleted.
                if edit.kind == EditKind::Move {
                    // ENTERING an excluded folder. Leaving one is refused
                    // earlier and unconditionally by `excluded_note` above, which
                    // drops the body of any note whose CURRENT folder is
                    // excluded, so the two halves together are the clamp.
                    if folder_matches_excluded(&folder_of(&next), &excluded_now) {
                        outcome.refused.push(RefusedEdit {
                            note_id: edit.note_id.clone(),
                            index: *index,
                            reason: EditRejection::MoveIntoExcludedFolder,
                        });
                        continue;
                    }
                } else if edit_moves_note(body, &next) {
                    outcome.refused.push(RefusedEdit {
                        note_id: edit.note_id.clone(),
                        index: *index,
                        reason: EditRejection::NoteMoved,
                    });
                    continue;
                }
                // The carve-out, checked on the RESULT rather than on the edit's
                // text: whether a note ends up out of the working set is a fact
                // about the note after the edit, and reading it here means the
                // host never has to agree with the frontend about what a
                // removal looks like.
                if approval == Approval::Bulk && edit_hides_note(body, &next) {
                    outcome.refused.push(RefusedEdit {
                        note_id: edit.note_id.clone(),
                        index: *index,
                        reason: EditRejection::RemovalNeedsOwnAct,
                    });
                    continue;
                }
                originals
                    .entry(edit.note_id.clone())
                    .or_insert_with(|| Zeroizing::new(body.to_string()));
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
    let changed: Vec<BatchWrite> = bodies
        .into_iter()
        .filter(|(id, _)| touched.contains(id))
        .map(|(id, body)| BatchWrite {
            base: originals.remove(&id).map(|b| b.to_string()),
            note_id: id,
            text: body.to_string(),
        })
        .collect();

    // Nothing to rewrite is NOT nothing to do: a run may propose only new notes,
    // and an early return here would have skipped the create pass entirely. It
    // did, until the creation tests caught it.
    if !changed.is_empty() {
        // 4. Restore point BEFORE the write, and a failure here ends the apply.
        let note_ids: Vec<String> = changed.iter().map(|w| w.note_id.clone()).collect();
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

/// Writing one preference on behalf of an approved setting change.
///
/// **A seam rather than a direct call into the prefs plugin**, for two reasons
/// that both come down to the undo record. The value the change replaces has to
/// come out of the same write that replaces it, or the undo restores a value it
/// guessed; and the write has to go through the one path that bumps the prefs
/// nonce, so every other `usePrefs` reader hears about it. The desktop host
/// implements this over `vault.prefs`, and a test implements it over a map.
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait PrefWriter: Send + Sync {
    /// Write `value` for the intent's target, returning the value that was there
    /// before.
    ///
    /// **`None` is a CLEAR, not an empty value** (myne-md/myne#850 task 3): the
    /// `periodic_notes` entry is REMOVED rather than set to an empty string, and
    /// the prefs setter takes the same `Option` for the same reason. `None` on
    /// the return side means the setting had no value, which is what lets an undo
    /// tell "put X back" apart from "clear it again".
    ///
    /// An `Err` refuses this ONE setting and leaves the rest of the batch alone,
    /// the same contract a refused edit has.
    ///
    /// **It returns the whole pre-write state, not one value** (myne-md/myne#850):
    /// `(the value it replaced, the folder it replaced)`. Returning only the
    /// value is what let the undo of `files.new-note-location` rebuild the folder
    /// from live prefs and write the agent's own folder back; see
    /// `AppliedSetting::previous_folder` for the full account.
    async fn write_setting(
        &self,
        intent: &SettingIntent,
        value: Option<&str>,
        folder: Option<&str>,
    ) -> Result<(Option<String>, Option<String>), AgentError>;

    /// Make the folder an intent names exist, and report whether it now does.
    ///
    /// **The ensure step's named seam** (myne-md/myne#850 task 3), so promoting
    /// the folder set out of `vault.prefs` (myne-md/myne#615) moves this method
    /// rather than every intent that names a folder.
    ///
    /// `false` means a removal of that folder is on record and nothing was
    /// registered: the ensure must not resurrect a deletion the user made. The
    /// caller reports that as a refusal rather than writing a setting whose
    /// effect silently does not hold, because a folder that is not registered
    /// does not appear in the sidebar until its first note.
    async fn ensure_folder(&self, folder: &str) -> Result<bool, AgentError>;
}

/// Why a setting change did not land.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingRejection {
    /// It arrived under a bulk approval. **A setting change is always its own
    /// act**, because the rule that makes "approve all" safe is a bound over
    /// note grants, and a setting sits inside no grant at all.
    NeedsOwnAct,
    /// The setting is no longer writable: the intent table moved under the run,
    /// or the id was changed after the proposal. Re-derived here rather than
    /// trusted from the proposal, which is a request and not a receipt.
    NotWritable,
    /// The value no longer validates, for the same reason.
    InvalidValue,
    /// The folder this setting names is on record as REMOVED, so the ensure step
    /// will not bring it back (myne-md/myne#850 task 3).
    ///
    /// Its own reason rather than folding into `WriteFailed`, because the user's
    /// action is different in the two cases: one is "try again", and this one is
    /// "you deleted that folder, and I am not undoing that for you".
    FolderRemoved,
    /// The setting cannot be CLEARED, because the prefs setter for it takes a
    /// required value (myne-md/myne#850 task 4). Writing an empty string and
    /// calling it a clear would be storing a value, which is the difference the
    /// clear verb exists to keep.
    NotClearable,
    /// The write itself failed.
    WriteFailed,
    /// The host never recorded the model proposing this change.
    ///
    /// **The note path has refused this since `EditRejection::NotProposed`, and
    /// settings had no equivalent** (2026-10-13 review), which is what made the
    /// offer a page-supplied argument rather than a bound: a caller could name a
    /// setting in its own `agent_apply` that the run never proposed.
    NotProposed,
    /// The run was stopped before the write, so nothing was attempted.
    ///
    /// **Its own reason rather than `WriteFailed`** (myne-md/myne#850, from
    /// review). `apply_settings_approved` opens with `runs.is_writable(run_id)?`,
    /// whose errors are `Cancelled` and `NoSuchRun`, and the catch-all reported
    /// both as a transient write failure: the user is invited to retry a run they
    /// deliberately stopped, and `writeFailed`'s copy says the write failed for a
    /// write that never happened.
    RunStopped,
}

/// One setting change that did not land.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedSetting {
    /// Which setting it was for.
    pub intent_id: String,
    /// Its index in the approved list, so the surface marks the row the user
    /// actually looked at rather than guessing by content.
    pub index: usize,
    /// Why it did not land.
    pub reason: SettingRejection,
}

/// What applying the approved setting changes did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SettingsOutcome {
    /// The settings that landed, with the value each replaced.
    pub applied: Vec<AppliedSetting>,
    /// The settings that did not, with their causes.
    pub refused: Vec<RefusedSetting>,
}

/// Apply the setting changes the user approved.
///
/// **Its own function rather than a fourth parameter on [`apply_approved`]**,
/// and the shape is the argument: a setting write has no note scope to check, no
/// restore point to take and no batch to be atomic with, so threading it through
/// the note pipeline would have made every call site carry a parameter it does
/// not use on the path that writes note bodies.
///
/// **The bulk carve-out lives here**, the same place and for the same reason the
/// removal carve-out lives in [`apply_approved`]: the rule is about what the user
/// did, so a frontend filter would only ever be as true as the current frontend,
/// and the host could not detect the mistake afterwards.
pub async fn apply_settings_approved(
    runs: &AgentRunState,
    run_id: &str,
    approved: &[(usize, ProposedSetting)],
    approval: Approval,
    prefs: &dyn PrefWriter,
) -> Result<SettingsOutcome, AgentError> {
    let mut outcome = SettingsOutcome::default();
    if approved.is_empty() {
        return Ok(outcome);
    }
    // 0. The approval LABEL is bounded first, exactly as the note path bounds
    //    it and for the same reason: an approve-all relabelled `individual`
    //    would otherwise carry several setting changes past a control whose
    //    predicate is the label. Found by symmetry with myne-md/myne#531, which
    //    is where the note-path version of this line came from.
    if approval == Approval::Individual && approved.len() > 1 {
        return Err(AgentError::IndividualApprovalNotSingle);
    }
    // Stop bounds the WRITE here too, not only the model: a run the user stopped
    // must not change a setting on a later click any more than it may write a
    // note.
    runs.is_writable(run_id)?;
    for (index, setting) in approved {
        if approval == Approval::Bulk {
            outcome.refused.push(RefusedSetting {
                intent_id: setting.intent_id.clone(),
                index: *index,
                reason: SettingRejection::NeedsOwnAct,
            });
            continue;
        }
        // Re-derived, never trusted from the proposal: the intent table is the
        // authority and the proposal is a request.
        let intent = match super::setting::writable(&setting.intent_id) {
            Ok(intent) => intent,
            Err(_) => {
                outcome.refused.push(RefusedSetting {
                    intent_id: setting.intent_id.clone(),
                    index: *index,
                    reason: SettingRejection::NotWritable,
                });
                continue;
            }
        };
        // Validation applies to a SET only (myne-md/myne#850 task 3). A clear has
        // no value to check, and the removal direction is never refused, which is
        // the set-mutation module's own stated rule.
        if let Some(value) = setting.value.as_deref() {
            if super::setting::validate(intent, value, setting.folder.as_deref()).is_err() {
                outcome.refused.push(RefusedSetting {
                    intent_id: setting.intent_id.clone(),
                    index: *index,
                    reason: SettingRejection::InvalidValue,
                });
                continue;
            }
        } else if !intent.target.clearable() {
            // **A clear needs a setter that can express one** (task 4). Two of
            // the targets route through setters taking a required value, so
            // there is nothing to ask for the empty state with; writing an empty
            // string instead would store a VALUE and call it a removal, which is
            // the difference the clear verb exists to keep.
            outcome.refused.push(RefusedSetting {
                intent_id: setting.intent_id.clone(),
                index: *index,
                reason: SettingRejection::NotClearable,
            });
            continue;
        }
        // **The ensure step, before the write.** A setting that names a folder
        // owes a registered one, and this refuses when a removal of that folder
        // is on record, so the setting is refused BEFORE anything is written
        // rather than landing with its effect silently missing.
        //
        // The folder comes from `folder_named`, not from the value alone: a
        // mode-and-folder setting names it in the sub-step, and reading the MODE
        // as a folder is how `root` would end up registered.
        if let Some(folder) = super::setting::folder_named(
            intent,
            setting.value.as_deref(),
            setting.folder.as_deref(),
        ) {
            match prefs.ensure_folder(folder).await {
                Ok(true) => {}
                Ok(false) => {
                    outcome.refused.push(RefusedSetting {
                        intent_id: setting.intent_id.clone(),
                        index: *index,
                        reason: SettingRejection::FolderRemoved,
                    });
                    continue;
                }
                Err(_) => {
                    outcome.refused.push(RefusedSetting {
                        intent_id: setting.intent_id.clone(),
                        index: *index,
                        reason: SettingRejection::WriteFailed,
                    });
                    continue;
                }
            }
        }
        match prefs
            .write_setting(intent, setting.value.as_deref(), setting.folder.as_deref())
            .await
        {
            Ok((previous, previous_folder)) => outcome.applied.push(AppliedSetting {
                intent_id: intent.id.to_string(),
                previous,
                previous_folder,
            }),
            Err(_) => outcome.refused.push(RefusedSetting {
                intent_id: setting.intent_id.clone(),
                index: *index,
                reason: SettingRejection::WriteFailed,
            }),
        }
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::agent::edit::EditKind;
    use crate::test_support::block_on;
    use std::collections::BTreeSet;
    use std::sync::Mutex;

    fn ids(v: &[&str]) -> BTreeSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn edit(note: &str, anchor: &str, replacement: &str) -> ProposedEdit {
        ProposedEdit {
            note_id: note.into(),
            kind: EditKind::Replace,
            anchor: anchor.into(),
            replacement: replacement.into(),
        }
    }

    fn append_edit(note: &str, text: &str) -> ProposedEdit {
        ProposedEdit {
            note_id: note.into(),
            kind: EditKind::Append,
            anchor: String::new(),
            replacement: text.into(),
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
        /// The merge base each write carried, by note id. Empty for a write with
        /// no base, which is the intentional-replace case.
        bases: Mutex<BTreeMap<String, Option<String>>>,
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
                bases: Mutex::new(BTreeMap::new()),
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
        async fn write_batch(&self, notes: Vec<BatchWrite>) -> Result<(), AgentError> {
            let mut m = self.notes.lock().unwrap();
            for write in notes {
                self.bases
                    .lock()
                    .unwrap()
                    .insert(write.note_id.clone(), write.base.clone());
                m.insert(write.note_id, write.text);
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

    /// **The write carries the body the edit was applied to.**
    ///
    /// This is the merge base a live session needs: without it the patch is a
    /// whole-text replacement, and a peer edit merged between this apply's read
    /// and its write is deleted rather than merged (myne-md/myne#893 follow-up).
    /// Asserted on the writer's own receipt, because the failure is invisible in
    /// the returned note: the write succeeds either way, and only the base says
    /// whether it merged or overwrote.
    #[test]
    fn a_batch_write_carries_the_body_the_edit_was_derived_from() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let disk = Disk::with(&[("a", "alpha world"), ("b", "untouched")], true);
        block_on(apply_approved(
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
        let bases = disk.bases.lock().unwrap().clone();
        assert_eq!(
            bases.get("a").cloned().flatten().as_deref(),
            Some("alpha world")
        );
        // A note no edit landed on is not written at all, so it has no base.
        assert!(!bases.contains_key("b"));
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
            // `Bulk`, because the batch carries more than one item and
            // nothing here is a removal. `Individual` is now bounded to a
            // single change (myne-md/myne#531 review round six); these
            // three tests had been labelling multi-item batches
            // `individual`, which is the gap that finding is about,
            // reachable from the suite itself.
            Approval::Bulk,
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
    // ---- the approval label's arity ------------------------------------

    /// The carve-out fires only on `Bulk`, so `Individual` must be able to carry
    /// only one thing (myne-md/myne#531 review round six).
    ///
    /// Asserted on the DISK, like every other test of this control: a host that
    /// returned the error and wrote anyway would pass a return-value check.
    #[test]
    fn an_individual_approval_carrying_more_than_one_edit_is_refused_and_writes_nothing() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let before_a = note_with("title: A");
        let before_b = note_with("title: B");
        let disk = Disk::with(&[("a", &before_a), ("b", &before_b)], true);
        let err = block_on(apply_approved(
            &runs,
            "r",
            &[
                edit("a", "title: A", "title: A2"),
                // The one the relabelling exists to smuggle through.
                edit("b", "title: B", &format!("title: B\ndeleted: {TRASH_TS}")),
            ],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap_err();
        assert!(
            matches!(err, AgentError::IndividualApprovalNotSingle),
            "expected the arity refusal, got {err:?}"
        );
        assert_eq!(disk.read_back("a"), before_a, "nothing may be written");
        assert_eq!(disk.read_back("b"), before_b, "nothing may be written");
    }

    /// A new note counts toward the same one, so the two halves cannot be
    /// combined to get two writes out of one individual approval.
    #[test]
    fn an_individual_approval_of_one_edit_plus_one_new_note_is_refused() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", &note_with("title: A"))], true);
        let err = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "title: A", "title: A2")],
            &[(0, new_note("N", None))],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap_err();
        assert!(matches!(err, AgentError::IndividualApprovalNotSingle));
    }

    /// The direction the gate must NOT break: one edit on its own still applies,
    /// including one that removes a note, which is the whole point of the label.
    #[test]
    fn a_single_edit_individual_approval_still_applies_including_a_removal() {
        for line in ["title: A2", &format!("title: A\ndeleted: {TRASH_TS}")] {
            let runs = AgentRunState::default();
            runs.start("r".into(), ids(&["a"]));
            let disk = Disk::with(&[("a", &note_with("title: A"))], true);
            let out = block_on(apply_approved(
                &runs,
                "r",
                &[edit("a", "title: A", line)],
                &[],
                &[],
                Approval::Individual,
                &disk,
                &disk,
                &disk,
            ))
            .unwrap();
            assert_eq!(out.applied, 1, "{line}");
            assert!(out.refused.is_empty(), "{line}");
        }
    }

    /// And a BULK approval is not bounded by arity, only by the carve-out. A
    /// gate that also capped `Bulk` would break approve-all entirely.
    #[test]
    fn a_bulk_approval_may_still_carry_many_edits() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let disk = Disk::with(
            &[("a", &note_with("title: A")), ("b", &note_with("title: B"))],
            true,
        );
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[
                edit("a", "title: A", "title: A2"),
                edit("b", "title: B", "title: B2"),
            ],
            &[],
            &[],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 2);
    }

    // ---- the append verb, through the whole apply path ------------------

    /// The reported case, end to end at this layer: a note with nothing in its
    /// body, and a request to write into it. Before the verb existed this was
    /// structurally impossible, since an anchored edit needs text to anchor to.
    #[test]
    fn an_append_into_an_empty_note_lands_on_disk() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", "---\ntitle: T\n---\n")], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[append_edit("a", "the list")],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 1);
        assert!(out.refused.is_empty());
        assert_eq!(disk.read_back("a"), "---\ntitle: T\n---\nthe list\n");
    }

    /// An append inherits every check the replace shape gets, which is the
    /// entire argument for putting it on `ProposedEdit` rather than in a list of
    /// its own. Scope first.
    #[test]
    fn an_append_outside_the_scope_is_refused_like_any_other_edit() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", &note_with("title: T"))], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[append_edit("b", "text")],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 0);
        assert_eq!(out.refused[0].reason, EditRejection::OutOfScope);
    }

    /// **An append cannot hide a note, and the positioning is why.** Text that
    /// looks exactly like a `trashed:` frontmatter block lands in the BODY,
    /// after the note's real block, so it is prose rather than a marker: the
    /// removal carve-out reads the frontmatter and correctly sees nothing.
    ///
    /// Asserted rather than assumed, because "the check did not fire" and "the
    /// check could not see it" look identical from the outside, and the second
    /// is the one this verb has to be true. The disk read-back is what
    /// distinguishes them: the note is still live afterwards.
    #[test]
    fn an_append_cannot_hide_a_note_because_its_text_lands_in_the_body() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let before = "---\ntitle: T\n---\n";
        let disk = Disk::with(&[("a", before)], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[append_edit("a", &format!("---\ntrashed: {TRASH_TS}\n---"))],
            &[],
            &[],
            Approval::Bulk,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 1, "it is ordinary body text, so it applies");
        let after = disk.read_back("a");
        assert!(
            after.starts_with("---\ntitle: T\n---\n"),
            "the note's own frontmatter is still the first block: {after:?}"
        );
        assert!(
            !crate::plugins::agent::hide::edit_hides_note(before, &after),
            "and the result is still a live note, which is the property that matters"
        );
    }

    /// The hostile spelling of the test above, and the one that used to get
    /// through: a note with NO frontmatter whose body merely BEGINS with
    /// `---`. Nothing had closed that opener, so appended text carrying an
    /// ordinary `---` separator closed it and the user's own first lines became
    /// a frontmatter block, `trashed:` among them. Asserted on the DISK, since
    /// a host that reported the refusal and wrote anyway would satisfy a
    /// return-value assertion.
    #[test]
    fn an_append_may_not_close_an_opener_the_note_body_merely_starts_with() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let before = "---\nmy shopping list\nmilk\n";
        let disk = Disk::with(&[("a", before)], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[append_edit(
                "a",
                &format!("## Summary\n\ntrashed: {TRASH_TS}\n\n---\n\ndone"),
            )],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 0, "the append is refused, not mangled");
        assert_eq!(
            disk.read_back("a"),
            before,
            "and the note on disk is untouched"
        );
    }

    // ---- the folder lock -----------------------------------------------

    /// Asserted on the DISK, for the reason the removal tests one screen down
    /// give: a host that reported the refusal and wrote anyway would pass a
    /// return-value assertion.
    ///
    /// Under BOTH approval labels, which is the difference from the removal
    /// carve-out. That one is a bulk-only rule because approving a removal on
    /// its own act is a legitimate thing for a user to do; there is no act that
    /// makes an agent-chosen folder move correct, because the folder is what
    /// `ai_excluded_folders` is keyed on.
    #[test]
    fn an_edit_that_moves_the_note_to_another_folder_is_refused_under_every_label() {
        for approval in [Approval::Bulk, Approval::Individual] {
            let runs = AgentRunState::default();
            runs.start("r".into(), ids(&["a"]));
            let before = note_with("title: T\nfolder: Work");
            let disk = Disk::with(&[("a", &before)], true);
            let out = block_on(apply_approved(
                &runs,
                "r",
                &[edit("a", "folder: Work", "folder: Secrets")],
                &[],
                &[],
                approval,
                &disk,
                &disk,
                &disk,
            ))
            .unwrap();
            assert_eq!(out.applied, 0, "{approval:?}");
            assert_eq!(out.refused.len(), 1, "{approval:?}");
            assert_eq!(
                out.refused[0].reason,
                EditRejection::NoteMoved,
                "{approval:?}"
            );
            assert_eq!(
                disk.read_back("a"),
                before,
                "{approval:?}: the note must be byte-identical"
            );
        }
    }

    /// The other direction, and the one that actually widens what the model can
    /// read: moving a note OUT of an excluded folder would hand its plaintext to
    /// the next run's tools.
    #[test]
    fn an_edit_that_moves_a_note_out_of_a_folder_is_refused_too() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let before = note_with("title: T\nfolder: Private");
        let disk = Disk::with(&[("a", &before)], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "folder: Private\n", "")],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 0);
        assert_eq!(out.refused[0].reason, EditRejection::NoteMoved);
        assert_eq!(disk.read_back("a"), before);
    }

    /// The lock must not swallow the edits it was never about. An ordinary body
    /// edit and a retitle both still apply, which is what keeps this a bug fix
    /// rather than a withdrawal of the agent's job.
    #[test]
    fn the_folder_lock_does_not_refuse_an_ordinary_edit_or_a_retitle() {
        for (anchor, replacement) in [("body", "body rewritten"), ("title: T", "title: T2")] {
            let runs = AgentRunState::default();
            runs.start("r".into(), ids(&["a"]));
            let disk = Disk::with(&[("a", &note_with("title: T\nfolder: Work"))], true);
            let out = block_on(apply_approved(
                &runs,
                "r",
                &[edit("a", anchor, replacement)],
                &[],
                &[],
                Approval::Individual,
                &disk,
                &disk,
                &disk,
            ))
            .unwrap();
            assert_eq!(out.applied, 1, "{anchor}");
            assert!(out.refused.is_empty(), "{anchor}");
        }
    }

    // ---- the move verb, through the whole apply path --------------------
    //
    // The clamp lives HERE rather than in `edit.rs` because it needs the excluded
    // set, which only the apply path holds. These four configurations are the
    // task's acceptance criteria, and the two refused ones are what go red when
    // the clamp is deleted: a permitted-to-permitted move applied under either
    // is what a clamp-less implementation would do, so only the refusals
    // distinguish a working clamp from a missing one.

    fn move_edit(note: &str, folder: &str) -> ProposedEdit {
        ProposedEdit {
            note_id: note.into(),
            kind: EditKind::Move,
            anchor: String::new(),
            replacement: folder.into(),
        }
    }

    #[test]
    fn a_move_between_two_permitted_folders_lands_on_disk() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let disk = Disk::with(&[("a", &note_with("title: T\nfolder: Work"))], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[move_edit("a", "Projects")],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 1);
        assert!(out.refused.is_empty());
        assert!(
            disk.read_back("a").contains("folder: Projects"),
            "{}",
            disk.read_back("a")
        );
    }

    /// The direction the lock never covered, and the one the verb bought its
    /// clamp for: the destination is an excluded folder.
    #[test]
    fn a_move_into_an_excluded_folder_is_refused_and_writes_nothing() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let before = note_with("title: T\nfolder: Work");
        let disk = Disk::with(&[("a", &before)], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[move_edit("a", "Private")],
            &[],
            &["Private/".to_string()],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 0);
        assert_eq!(out.refused.len(), 1);
        assert_eq!(out.refused[0].reason, EditRejection::MoveIntoExcludedFolder);
        assert_eq!(disk.read_back("a"), before, "the note is byte-identical");
    }

    /// And the mirror: leaving an excluded folder. Refused by the pre-batch
    /// clamp, which reads the note's CURRENT folder, hence a different cause.
    #[test]
    fn a_move_out_of_an_excluded_folder_is_refused_too() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let before = note_with("title: T\nfolder: Private");
        let disk = Disk::with(&[("a", &before)], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[move_edit("a", "Work")],
            &[],
            &["Private/".to_string()],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 0);
        assert_eq!(out.refused[0].reason, EditRejection::ExcludedNow);
        assert_eq!(disk.read_back("a"), before);
    }

    /// The direction a clamp written as "refuse any folder change" would get
    /// wrong: a destination that canonicalises to the folder the note is already
    /// in. It is refused, but under its own cause, and nothing is written.
    #[test]
    fn a_move_to_the_same_folder_is_its_own_cause_not_an_exclusion() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let before = note_with("title: T\nfolder: Work");
        let disk = Disk::with(&[("a", &before)], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[move_edit("a", "work/")],
            &[],
            &[],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 0);
        assert_eq!(out.refused[0].reason, EditRejection::MoveToSameFolder);
        assert_eq!(disk.read_back("a"), before);
    }

    // ---- the removal carve-out -----------------------------------------

    /// **Every marker, not only `trashed:`.** The shipped carve-out read one
    /// field, and a `deleted:` edit — which hides the note from Trash as well as
    /// from the sidebar, so the user cannot reach it from any view — rode along
    /// inside an approve-all (myne-md/myne#531 review round five). Asserted on
    /// the DISK for the same reason the single-field version is: a host that
    /// reported the refusal and wrote anyway would pass a return-value check.
    #[test]
    fn a_bulk_approval_cannot_remove_a_note_by_any_marker() {
        for line in [
            "trashed: 2026-08-16T10:00:00Z",
            "deleted: 2026-08-16T10:00:00Z",
            "archived: 2026-08-16T10:00:00Z",
            "template: true",
            "conflict: true",
        ] {
            let runs = AgentRunState::default();
            runs.start("r".into(), ids(&["a"]));
            let before = note_with("title: T");
            let disk = Disk::with(&[("a", &before)], true);
            let out = block_on(apply_approved(
                &runs,
                "r",
                &[edit("a", "title: T", &format!("title: T\n{line}"))],
                &[],
                &[],
                Approval::Bulk,
                &disk,
                &disk,
                &disk,
            ))
            .unwrap();
            assert_eq!(out.applied, 0, "{line}");
            assert_eq!(out.refused.len(), 1, "{line}");
            assert_eq!(
                out.refused[0].reason,
                EditRejection::RemovalNeedsOwnAct,
                "{line}"
            );
            assert_eq!(
                disk.read_back("a"),
                before,
                "{line}: the note must be byte-identical"
            );
        }
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
            // `Bulk`, because the batch carries more than one item and
            // nothing here is a removal. `Individual` is now bounded to a
            // single change (myne-md/myne#531 review round six); these
            // three tests had been labelling multi-item batches
            // `individual`, which is the gap that finding is about,
            // reachable from the suite itself.
            Approval::Bulk,
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

    #[test]
    fn a_cancelled_run_cannot_apply() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        runs.cancel("r");
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
        ));
        assert!(matches!(out, Err(AgentError::Cancelled)));
        // The state, not the return value: a refusal that still wrote would
        // report the same error.
        assert_eq!(disk.read_back("a"), "hello world");
    }

    /// SYNC-14 has no in-flight carve-out: an exclusion the user adds while a
    /// review is pending refuses the edit, even though the note is inside the
    /// scope they granted earlier.
    #[test]
    fn an_exclusion_added_mid_run_refuses_an_edit_in_the_frozen_scope() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let body = "---\ntitle: T\nfolder: Private/\n---\n\nhello world";
        let disk = Disk::with(&[("a", body)], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "hello world", "goodbye")],
            &[],
            &["Private/".to_string()],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 0);
        assert_eq!(out.refused.len(), 1);
        assert_eq!(out.refused[0].reason, EditRejection::ExcludedNow);
        assert_eq!(disk.read_back("a"), body, "and nothing was written");
    }

    #[test]
    fn a_note_outside_every_exclusion_still_applies() {
        // The other direction, so the clamp cannot pass by refusing everything.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let body = "---\ntitle: T\nfolder: Work/\n---\n\nhello world";
        let disk = Disk::with(&[("a", body)], true);
        let out = block_on(apply_approved(
            &runs,
            "r",
            &[edit("a", "hello world", "goodbye")],
            &[],
            &["Private/".to_string()],
            Approval::Individual,
            &disk,
            &disk,
            &disk,
        ))
        .unwrap();
        assert_eq!(out.applied, 1);
        assert!(disk.read_back("a").contains("goodbye"));
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
            // `Bulk`, because the batch carries more than one item and
            // nothing here is a removal. `Individual` is now bounded to a
            // single change (myne-md/myne#531 review round six); these
            // three tests had been labelling multi-item batches
            // `individual`, which is the gap that finding is about,
            // reachable from the suite itself.
            Approval::Bulk,
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

    // ---- setting intents (myne-md/myne#850) -------------------------------

    /// One recorded write: `(intent id, value, folder)`, each optional where the
    /// change did not carry it. A named alias rather than the tuple inline,
    /// because the third slot arrived with the sub-step and the type reads as
    /// noise at every use.
    type RecordedWrite = (String, Option<String>, Option<String>);

    /// A writer that records what it was asked to write and answers with a fixed
    /// "previous" value, so the record half can be asserted without a vault.
    struct StubPrefs {
        /// `(intent id, value, folder)` per write, with `None` for a CLEAR, the
        /// distinction the clear verb exists for (myne-md/myne#850 task 3), and
        /// the third slot carrying the sub-step a mode-and-folder setting sends.
        writes: Mutex<Vec<RecordedWrite>>,
        previous: Option<String>,
        /// The FOLDER in place before the write, for the one target with two
        /// fields. The stub returns it so a test can drive the undo of
        /// `files.new-note-location` without a real vault.
        previous_folder: Option<String>,
        /// What `ensure_folder` answers. `true` is the ordinary case; `false` is
        /// a removal on record, which is what the FolderRemoved refusal is for.
        folder_ensured: bool,
        fail: bool,
    }

    impl StubPrefs {
        fn new(previous: Option<&str>) -> Self {
            Self {
                writes: Mutex::new(Vec::new()),
                previous: previous.map(str::to_string),
                previous_folder: None,
                folder_ensured: true,
                fail: false,
            }
        }

        fn failing() -> Self {
            Self {
                writes: Mutex::new(Vec::new()),
                previous: None,
                previous_folder: None,
                folder_ensured: true,
                fail: true,
            }
        }

        /// The same, with the ensure step reporting a removal on record.
        fn with_removed_folder() -> Self {
            Self {
                writes: Mutex::new(Vec::new()),
                previous: Some("Old/".to_string()),
                previous_folder: None,
                folder_ensured: false,
                fail: false,
            }
        }

        fn writes(&self) -> Vec<RecordedWrite> {
            self.writes.lock().expect("stub prefs lock").clone()
        }
    }

    #[async_trait::async_trait]
    impl PrefWriter for StubPrefs {
        async fn write_setting(
            &self,
            intent: &SettingIntent,
            value: Option<&str>,
            folder: Option<&str>,
        ) -> Result<(Option<String>, Option<String>), AgentError> {
            if self.fail {
                return Err(AgentError::WriteFailed);
            }
            self.writes.lock().expect("stub prefs lock").push((
                intent.id.to_string(),
                value.map(str::to_string),
                folder.map(str::to_string),
            ));
            // The whole pre-write state, matching the real adapter's contract.
            Ok((self.previous.clone(), self.previous_folder.clone()))
        }

        async fn ensure_folder(&self, _folder: &str) -> Result<bool, AgentError> {
            if self.fail {
                return Err(AgentError::WriteFailed);
            }
            Ok(self.folder_ensured)
        }
    }

    fn setting(id: &str, value: &str) -> ProposedSetting {
        ProposedSetting {
            intent_id: id.into(),
            value: Some(value.into()),
            folder: None,
        }
    }

    /// The same, as a CLEAR: no value at all, which is a different proposal from
    /// one carrying an empty string.
    fn clearing(id: &str) -> ProposedSetting {
        ProposedSetting {
            intent_id: id.into(),
            value: None,
            folder: None,
        }
    }

    /// The sub-step shape: a mode plus the folder it needs (myne-md/myne#850
    /// task 4).
    fn setting_with_folder(id: &str, value: &str, folder: &str) -> ProposedSetting {
        ProposedSetting {
            intent_id: id.into(),
            value: Some(value.into()),
            folder: Some(folder.into()),
        }
    }

    /// A solo approval writes the setting and reports the value it replaced, so
    /// the undo record has something to restore rather than something to guess.
    #[test]
    fn a_setting_write_lands_and_carries_the_previous_value() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let prefs = StubPrefs::new(Some("Old/Weekly"));
        let out = block_on(apply_settings_approved(
            &runs,
            "r",
            &[(0, setting("editor.weekly-notes-folder", "J/Weekly"))],
            Approval::Individual,
            &prefs,
        ))
        .expect("a solo approval is valid");
        assert!(out.refused.is_empty());
        assert_eq!(out.applied.len(), 1);
        assert_eq!(out.applied[0].intent_id, "editor.weekly-notes-folder");
        assert_eq!(out.applied[0].previous.as_deref(), Some("Old/Weekly"));
        assert_eq!(
            prefs.writes(),
            vec![(
                "editor.weekly-notes-folder".to_string(),
                Some("J/Weekly".to_string()),
                None
            )]
        );
    }

    /// **A clear is a REMOVAL, not a set to empty** (myne-md/myne#850 task 3).
    /// The writer is handed `None`, which is what the prefs setter takes as
    /// "remove the entry"; an empty string would be a value a folder could be
    /// compared against, so the two must not share a spelling anywhere.
    #[test]
    fn a_clear_is_a_removal_rather_than_a_set_to_empty() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let prefs = StubPrefs::new(Some("J/Weekly"));
        let out = block_on(apply_settings_approved(
            &runs,
            "r",
            &[(0, clearing("editor.weekly-notes-folder"))],
            Approval::Individual,
            &prefs,
        ))
        .expect("a solo approval is valid");
        assert!(out.refused.is_empty());
        assert_eq!(out.applied.len(), 1);
        // The previous value is carried, so the undo can put it back.
        assert_eq!(out.applied[0].previous.as_deref(), Some("J/Weekly"));
        assert_eq!(
            prefs.writes(),
            vec![("editor.weekly-notes-folder".to_string(), None, None)],
            "a clear must reach the writer as None, never as an empty value"
        );
    }

    /// **A removal on record is not resurrected by the ensure step.** The
    /// setting is refused BEFORE anything is written, so it does not land with
    /// its effect silently missing.
    #[test]
    fn a_folder_on_record_as_removed_refuses_the_setting_before_the_write() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let prefs = StubPrefs::with_removed_folder();
        let out = block_on(apply_settings_approved(
            &runs,
            "r",
            &[(0, setting("editor.weekly-notes-folder", "J/Weekly"))],
            Approval::Individual,
            &prefs,
        ))
        .expect("a solo approval is valid");
        assert!(out.applied.is_empty());
        assert_eq!(out.refused.len(), 1);
        assert_eq!(out.refused[0].reason, SettingRejection::FolderRemoved);
        assert!(
            prefs.writes().is_empty(),
            "the refusal must come before the write"
        );
    }

    /// And the ordinary direction, so the ensure gate cannot pass by refusing
    /// everything: a folder with no removal on record writes normally.
    #[test]
    fn a_folder_with_no_removal_on_record_writes_normally() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let prefs = StubPrefs::new(None);
        let out = block_on(apply_settings_approved(
            &runs,
            "r",
            &[(0, setting("editor.weekly-notes-folder", "J/Weekly"))],
            Approval::Individual,
            &prefs,
        ))
        .expect("a solo approval is valid");
        assert_eq!(out.applied.len(), 1);
        assert!(out.refused.is_empty());
    }

    /// A clear does not run the ensure step: there is no folder to register, and
    /// asking about one would refuse a removal for naming a folder it is
    /// removing.
    #[test]
    fn a_clear_does_not_consult_the_ensure_step() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let prefs = StubPrefs::with_removed_folder();
        let out = block_on(apply_settings_approved(
            &runs,
            "r",
            &[(0, clearing("editor.weekly-notes-folder"))],
            Approval::Individual,
            &prefs,
        ))
        .expect("a solo approval is valid");
        assert_eq!(
            out.applied.len(),
            1,
            "removing a setting is never refused by a folder's removal record"
        );
        assert!(out.refused.is_empty());
    }

    /// **A mode-and-folder setting writes BOTH fields as one change**
    /// (myne-md/myne#850 task 4). The mode and the folder are one setting over
    /// two pref fields, so the folder rides the same write rather than a second
    /// change that could desync from the first.
    #[test]
    fn a_mode_and_folder_setting_carries_its_folder_in_the_same_write() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let prefs = StubPrefs::new(Some("root"));
        let out = block_on(apply_settings_approved(
            &runs,
            "r",
            &[(
                0,
                setting_with_folder("files.new-note-location", "specific", "J/Weekly"),
            )],
            Approval::Individual,
            &prefs,
        ))
        .expect("a solo approval is valid");
        assert!(out.refused.is_empty());
        assert_eq!(out.applied.len(), 1);
        assert_eq!(
            prefs.writes(),
            vec![(
                "files.new-note-location".to_string(),
                Some("specific".to_string()),
                Some("J/Weekly".to_string())
            )]
        );
    }

    /// A folder sent to a setting that takes one as its VALUE is refused, not
    /// ignored: the sub-step cannot be smuggled into a plain folder setting.
    #[test]
    fn a_folder_on_a_plain_folder_setting_is_refused() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let prefs = StubPrefs::new(None);
        let out = block_on(apply_settings_approved(
            &runs,
            "r",
            &[(
                0,
                setting_with_folder("editor.weekly-notes-folder", "J/Weekly", "Other/"),
            )],
            Approval::Individual,
            &prefs,
        ))
        .expect("a solo approval is valid");
        assert!(out.applied.is_empty());
        assert_eq!(out.refused[0].reason, SettingRejection::InvalidValue);
        assert!(prefs.writes().is_empty());
    }

    /// **A setting whose setter takes a required value cannot be cleared**
    /// (myne-md/myne#850 task 4). Writing an empty string and calling it a clear
    /// would store a value, which is the difference the clear verb keeps.
    #[test]
    fn a_clear_of_a_setting_with_no_empty_state_is_refused() {
        for id in [
            "editor.daily-notes-folder",
            "editor.daily-notes-date-format",
        ] {
            let runs = AgentRunState::default();
            runs.start("r".into(), ids(&["a"]));
            let prefs = StubPrefs::new(Some("X"));
            let out = block_on(apply_settings_approved(
                &runs,
                "r",
                &[(0, clearing(id))],
                Approval::Individual,
                &prefs,
            ))
            .expect("a solo approval is valid");
            assert!(out.applied.is_empty(), "{id} was cleared");
            assert_eq!(
                out.refused[0].reason,
                SettingRejection::NotClearable,
                "{id}"
            );
            assert!(prefs.writes().is_empty(), "{id} reached the writer");
        }
    }

    /// And the ordinary direction, so the clearable gate cannot pass by refusing
    /// every clear: a target whose setter takes an `Option` clears normally.
    #[test]
    fn a_clear_of_a_setting_with_an_empty_state_lands() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let prefs = StubPrefs::new(Some("YYYY-MM-DD"));
        let out = block_on(apply_settings_approved(
            &runs,
            "r",
            &[(0, clearing("editor.date-format"))],
            Approval::Individual,
            &prefs,
        ))
        .expect("a solo approval is valid");
        assert_eq!(out.applied.len(), 1);
        assert!(out.refused.is_empty());
    }

    /// A bulk approval may not carry a setting change, which
    /// is the rule that keeps "approve all" bounded: a setting sits inside no
    /// note grant, so nothing about the batch's shape says the user read it.
    /// The refusal also has to land BEFORE the write, which is what the empty
    /// write log proves.
    #[test]
    fn a_bulk_approval_may_not_carry_a_setting_change() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let prefs = StubPrefs::new(Some("Old/Weekly"));
        let out = block_on(apply_settings_approved(
            &runs,
            "r",
            &[
                (0, setting("editor.weekly-notes-folder", "J/Weekly")),
                (1, setting("files.new-note-location", "specific")),
            ],
            Approval::Bulk,
            &prefs,
        ))
        .expect("bulk is a valid label");
        assert!(out.applied.is_empty(), "nothing may land under bulk");
        assert_eq!(out.refused.len(), 2);
        assert!(out
            .refused
            .iter()
            .all(|r| r.reason == SettingRejection::NeedsOwnAct));
        assert!(
            prefs.writes().is_empty(),
            "the refusal must come before the write"
        );
    }

    /// An `individual` label carrying more than one change is refused outright,
    /// the same bound the note path makes and for the same reason: one approval
    /// act covers one change.
    #[test]
    fn an_individual_label_may_not_carry_two_setting_changes() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let prefs = StubPrefs::new(None);
        let err = block_on(apply_settings_approved(
            &runs,
            "r",
            &[
                (0, setting("editor.weekly-notes-folder", "J/Weekly")),
                (1, setting("files.new-note-location", "specific")),
            ],
            Approval::Individual,
            &prefs,
        ))
        .expect_err("two changes are not one individual act");
        assert!(matches!(err, AgentError::IndividualApprovalNotSingle));
        assert!(prefs.writes().is_empty());
    }

    /// A setting the table does not carry is refused at the WRITE even when a
    /// proposal names it. This is the second direction of the derivation: the
    /// loop refuses it, and so does the path that actually writes, so a
    /// tampered or stale proposal cannot reach the prefs blob.
    #[test]
    fn a_setting_outside_the_table_is_refused_at_the_write() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let prefs = StubPrefs::new(None);
        let out = block_on(apply_settings_approved(
            &runs,
            "r",
            &[(0, setting("appearance.theme", "dark"))],
            Approval::Individual,
            &prefs,
        ))
        .expect("a solo approval is valid");
        assert!(out.applied.is_empty());
        assert_eq!(out.refused[0].reason, SettingRejection::NotWritable);
        assert!(prefs.writes().is_empty());
    }

    /// An invalid value is refused before the write, for the same reason.
    #[test]
    fn an_invalid_value_is_refused_at_the_write() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let prefs = StubPrefs::new(None);
        let out = block_on(apply_settings_approved(
            &runs,
            "r",
            &[(0, setting("editor.weekly-notes-folder", "   "))],
            Approval::Individual,
            &prefs,
        ))
        .expect("a solo approval is valid");
        assert!(out.applied.is_empty());
        assert_eq!(out.refused[0].reason, SettingRejection::InvalidValue);
        assert!(prefs.writes().is_empty());
    }

    /// A failed write is a refusal of that one setting, not a failed apply, so
    /// the rest of a batch (and the surface's report) survives it.
    #[test]
    fn a_failed_write_refuses_that_setting_only() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let prefs = StubPrefs::failing();
        let out = block_on(apply_settings_approved(
            &runs,
            "r",
            &[(0, setting("editor.weekly-notes-folder", "J/Weekly"))],
            Approval::Individual,
            &prefs,
        ))
        .expect("the apply itself succeeds");
        assert!(out.applied.is_empty());
        assert_eq!(out.refused[0].reason, SettingRejection::WriteFailed);
    }

    /// An empty list writes nothing and does not even ask for the run, which is
    /// what lets a caller run settings and notes through their own paths without
    /// one of them failing on an empty batch.
    #[test]
    fn an_empty_setting_batch_is_a_no_op() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let prefs = StubPrefs::new(None);
        let out = block_on(apply_settings_approved(
            &runs,
            "r",
            &[],
            Approval::Bulk,
            &prefs,
        ))
        .expect("an empty batch is never a refusal");
        assert!(out.applied.is_empty());
        assert!(out.refused.is_empty());
        assert!(prefs.writes().is_empty());
    }
}
