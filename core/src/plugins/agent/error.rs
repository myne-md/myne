// SPDX-License-Identifier: AGPL-3.0
//! `agent` plugin core error taxonomy.
//!
//! One closed, `serde::Serialize` enum, DENY-list clean per `src-tauri/CLAUDE.md`
//! "Secret-handling logging discipline": no note ids in a `Display` string, no
//! paths, no plaintext. `note_id` appears as a structured field only where the
//! frontend already holds the id it sent, never inside prose.
//!
//! Deliberately one enum rather than one per command. The agent commands share a
//! single failure surface (the run either exists and is usable, or one of a
//! small set of stated things is wrong with it), and splitting it per command
//! would make the TS mirror five near-identical unions.

use serde::Serialize;
use thiserror::Error;

/// Why an edit the model proposed could not be placed.
///
/// This is a *result*, not only an error: a proposal routinely contains
/// placeable and unplaceable edits together, and the unplaceable ones are shown
/// to the user with their cause rather than dropped. See
/// [`super::edit::place`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditRejection {
    /// The anchor text does not occur in the note. Either the model invented it,
    /// or the note changed since the model read it. The two are deliberately not
    /// distinguished: the host cannot tell them apart, and a guess here would be
    /// a claim it cannot support.
    AnchorNotFound,
    /// The anchor text occurs more than once, so where the replacement goes is
    /// undetermined. Never resolved by picking the first match.
    AnchorAmbiguous,
    /// The anchor is empty, which would match at every position.
    AnchorEmpty,
    /// The note is not in the run's approved scope.
    OutOfScope,
    /// A note could not be read at apply time. Refuses that note's edits and
    /// leaves the rest of the batch alone.
    ReadFailed,
    /// A proposed new note's title or folder contains a newline, so writing it
    /// into frontmatter would emit fields nothing validated.
    UnsafeFrontmatter,
    /// The note now sits in an `ai_excluded_folders` folder.
    ///
    /// Distinct from `OutOfScope`, which is about the run's frozen grant. This
    /// one fires for a note the user DID grant and then excluded, or moved into
    /// an excluded folder, while the run was open or the review was pending.
    /// SYNC-14 carries no in-flight carve-out, so the newest answer decides.
    ExcludedNow,
    /// The proposed new note names an `ai_excluded_folders` folder.
    ///
    /// A new note's folder comes from the model, so it is the one write whose
    /// destination the scope clamp cannot cover: a note that does not exist yet
    /// is in no scope. The content control applies instead.
    ExcludedFolder,
    /// The proposed new note could not be written.
    ///
    /// **A cause rather than a propagated error, and that is the point.** A
    /// create runs LAST, after the edit batch has already been committed and
    /// after the run's restore point was taken. Returning `Err` from there
    /// discarded the whole `ApplyOutcome`, restore points included, so the
    /// edits stayed on disk with no undo record and the surface reported that
    /// nothing had been applied. Reporting the failed create as a refusal keeps
    /// the outcome, which is what the undo is built from.
    CreateFailed,
    /// The edit is not one the host recorded the model proposing.
    ///
    /// The edits arrive from the IPC payload as free strings, unlike the new
    /// notes, which are selected by index into the host's own record and whose
    /// doc says the caller "cannot invent a note the model never proposed". The
    /// same rule was stated for one half of the apply and implemented for one
    /// half (myne-md/myne#531 review round six).
    ///
    /// Not a TB6 widening: a WebView that can send this already holds the notes
    /// ACL and can write any note directly. What it costs is the integrity of
    /// the run record, since `restore_points` and the `AppliedRun` behind
    /// `agent_undo` would otherwise describe a run containing writes the model
    /// never proposed, presented to the user as one action.
    NotProposed,
    /// The edit would take a note OUT of the working set, and it arrived inside
    /// a batch the user approved in one action.
    ///
    /// Every removal in Myne is a frontmatter field — `trashed:`, `deleted:`,
    /// `archived:`, `template:`, `conflict:` — so at the diff layer it is
    /// indistinguishable from any other edit; this is the host refusing to let
    /// one ride along inside an approve-all. The user can still apply it, by
    /// approving it on its own. [`super::hide::edit_hides_note`] is the
    /// predicate and carries the roster.
    ///
    /// **Named for the class, not for `trashed:`.** It was `TrashNeedsOwnAct`
    /// and read only that one field, so a `deleted:` edit — which hides a note
    /// from Trash as well as from the sidebar — passed the carve-out entirely
    /// (myne-md/myne#531 review round five). A variant whose name says trash
    /// also puts a sentence in front of the user that would be false for the
    /// other four.
    RemovalNeedsOwnAct,
}

/// The agent plugin's failure surface.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum AgentError {
    /// Vault not unlocked when the command ran.
    #[error("vault is not unlocked")]
    SlotNotUnlocked,
    /// No run with that id. Either it finished, or the vault locked and took it
    /// with it (which is the design, not a fault).
    #[error("no such agent run")]
    NoSuchRun,
    /// AI is switched off for this vault.
    ///
    /// Read host-side from `vault.prefs`, not from the caller: the WebView
    /// hiding the surface is not a gate, and this is the one AI surface whose
    /// opt-in would otherwise live only in the page it is meant to constrain.
    #[error("AI is switched off for this vault")]
    AiDisabled,
    /// The run was cancelled, by the user or by a vault lock.
    #[error("agent run was cancelled")]
    Cancelled,
    /// A note the caller named is outside the run's approved scope. Carries the
    /// id because the caller already holds it.
    #[error("note is outside the run's approved scope")]
    OutOfScope {
        /// The id the caller sent, echoed back so the UI can mark it.
        note_id: String,
    },
    /// A note in the run's frozen scope now sits in an `ai_excluded_folders`
    /// folder, so the READ tool refused it.
    ///
    /// The read-side twin of [`EditRejection::ExcludedNow`], and distinct from
    /// `OutOfScope` for the same reason that one is: the user DID grant this
    /// note, and then excluded it, or moved it into an excluded folder, while the
    /// run was open. SYNC-14 carries no in-flight carve-out, so the newest answer
    /// decides for reads exactly as it already did for writes.
    #[error("note now sits in an excluded folder")]
    ExcludedNow,
    /// The grant resolved to nothing the run may use: every note in it was
    /// excluded, or the folder holds none.
    #[error("grant resolved to no usable notes")]
    EmptyGrant,
    /// A grant named a folder that canonicalizes to the vault root, which would
    /// grant the whole vault in one step and defeat the point of a grant.
    #[error("a grant may not name the vault root")]
    RootGrant,
    /// The run's restore point could not be taken, so the apply did not run.
    ///
    /// Not a warning and not recoverable-by-continuing: the restore point is the
    /// only thing that makes an agent edit reversible, and the interface has
    /// already told the user the run can be undone.
    #[error("the run's restore point could not be taken, so nothing was written")]
    RestorePointFailed,
    /// The transactional write failed. Nothing partial landed: the underlying
    /// batch is transactional, which is why this is one cause rather than a
    /// per-note report.
    #[error("writing the approved changes failed")]
    WriteFailed,
    /// Reading a note at apply time failed.
    #[error("reading a note failed")]
    ReadFailed,
    /// The configured backend cannot hold the anchored edit format, so agent
    /// mode is not offered on it.
    #[error("this model cannot produce the edit format agent mode needs")]
    EditFormatUnsupported,
    /// An apply labelled [`Approval::Individual`] carried more than one item.
    ///
    /// **The label is a fact about the click, so the host cannot derive it, but
    /// it must not be able to carry an unbounded batch either.** The
    /// removal carve-out ([`super::hide::edit_hides_note`]) fires only inside an
    /// [`Approval::Bulk`], so without this an approve-all relabelled
    /// `individual` applied forty edits, tombstone included, in one act. The
    /// predicate was host-side and its TRIGGER was the caller's, which is how a
    /// control reads as structural while being one field away from off
    /// (myne-md/myne#531 review round six).
    ///
    /// Not derived from the count instead: a user pressing Approve-all when one
    /// edit remains legitimately sends one item labelled `bulk`, and deriving
    /// would silently turn that into an individual approval and permit the
    /// removal the label was refusing.
    ///
    /// [`Approval::Individual`]: super::apply::Approval::Individual
    /// [`Approval::Bulk`]: super::apply::Approval::Bulk
    #[error("an individual approval may carry only one change")]
    IndividualApprovalNotSingle,
    /// A second step arrived for a run whose model call is still in flight.
    ///
    /// The host holds the run's transcript and proposal, and a step takes both
    /// out of the session for the length of the call. A concurrent second step
    /// would drive from an empty transcript and the later write-back would
    /// discard the other leg's work. Refused rather than serialised: the two
    /// legs answer different user actions, and running the second one after the
    /// first would answer it against a state the user never saw
    /// (myne-md/myne#531 review round six).
    #[error("this run is already working")]
    StepAlreadyRunning,
}

impl AgentError {
    /// Bounded, content-free tag for structured logging.
    ///
    /// Mirrors `EngineError::kind` and exists for the same reason: several
    /// variants carry a `note_id`, so a `Debug` format of this value in a log
    /// line would put a note identifier on disk. The DENY list in
    /// `src-tauri/CLAUDE.md` names `note_id` explicitly. A caller logs this;
    /// there is nothing else here safe to print.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::SlotNotUnlocked => "slot_not_unlocked",
            Self::NoSuchRun => "no_such_run",
            Self::AiDisabled => "ai_disabled",
            Self::Cancelled => "cancelled",
            Self::OutOfScope { .. } => "out_of_scope",
            Self::ExcludedNow => "excluded_now",
            Self::EmptyGrant => "empty_grant",
            Self::RootGrant => "root_grant",
            Self::RestorePointFailed => "restore_point_failed",
            Self::WriteFailed => "write_failed",
            Self::ReadFailed => "read_failed",
            Self::EditFormatUnsupported => "edit_format_unsupported",
            Self::IndividualApprovalNotSingle => "individual_approval_not_single",
            Self::StepAlreadyRunning => "step_already_running",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_serialize_without_prose_carrying_a_note_id() {
        let e = AgentError::OutOfScope {
            note_id: "abc".into(),
        };
        // The id is a structured field; the Display string must not carry it.
        assert!(!e.to_string().contains("abc"));
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("outOfScope") || json.contains("OutOfScope"));
    }

    #[test]
    fn rejections_are_distinct_causes_not_one_catch_all() {
        // The point of the taxonomy is that "not found" and "ambiguous" are
        // different facts about the note. Collapsing them would let a UI show
        // "could not apply" for a case the user could fix by narrowing.
        assert_ne!(
            EditRejection::AnchorNotFound,
            EditRejection::AnchorAmbiguous
        );
        assert_ne!(EditRejection::AnchorEmpty, EditRejection::AnchorNotFound);
    }
}
