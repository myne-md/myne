// SPDX-License-Identifier: AGPL-3.0
//! `agent` plugin core error taxonomy.
//!
//! One closed, `serde::Serialize` enum, DENY-list clean per `src-tauri/AGENTS.md`
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
    /// The edit would move the note to a different folder.
    ///
    /// `folder:` is what the `ai_excluded_folders` clamp reads, and the clamp
    /// runs against the note as it was BEFORE the batch. So without this, an
    /// anchored edit spanning that line could move a note into an
    /// excluded folder with no control seeing it: the clamp had already run and
    /// the removal roster does not carry the field.
    ///
    /// Distinct from [`Self::RemovalNeedsOwnAct`], which covers the five
    /// working-set markers and only inside a bulk approval. This one refuses
    /// under every approval label, because there is no act a user can take that
    /// makes an agent-chosen folder move correct.
    ///
    /// Deliberately narrower than "the frontmatter changed": `title:` and note
    /// properties are fields the agent legitimately edits.
    /// [`super::frontmatter::edit_moves_note`] carries that argument.
    NoteMoved,
    /// An append carried nothing to append.
    ///
    /// Its own reason rather than [`Self::AnchorEmpty`], which would be a false
    /// sentence: an append has no anchor by design, so telling the user there
    /// was "no text to match" describes a rule that does not apply to it.
    AppendEmpty,
    /// A move asked for the folder the note is already in.
    ///
    /// Its own reason rather than a silent success. The destination is compared
    /// canonically, so a note in `Work` moved to `work/` is the same folder, and
    /// letting that through would rewrite the note's bytes and bump its sync
    /// version for no change, which `apply.rs` takes care to avoid everywhere
    /// else. Naming it also gives the review screen a sentence that explains why
    /// nothing happened, instead of a row that looks applied.
    MoveToSameFolder,
    /// A move's destination is an `ai_excluded_folders` folder.
    ///
    /// **The second half of the two-way clamp.** The note's CURRENT folder is
    /// checked before the batch runs ([`Self::ExcludedNow`]), which refuses
    /// leaving an excluded folder; this one checks where the note would land, so
    /// the two together are the clamp in both directions. Distinct from
    /// [`Self::ExcludedFolder`], which is about a proposed NEW note and has no
    /// current folder to compare against.
    MoveIntoExcludedFolder,
    /// An append into a note with neither a frontmatter block nor a body would
    /// have authored one.
    ///
    /// Appended text normally lands after the frontmatter block, which makes it
    /// structurally impossible for it to be the first line. That positioning has
    /// nothing to work with when the note is entirely empty, so the one
    /// remaining case is refused rather than silently rewritten: mangling the
    /// model's text would leave the user approving something nobody wrote.
    AppendWouldWriteFrontmatter,
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
    /// A `remember` action failed the memory plugin's write-time gate
    /// (schema + 2000-character cap + injection scan, `decisions/ai/0590`).
    /// Refused at the write: a refused update or user write is never
    /// persisted; a refused MODEL create persists as `quarantined` (held for
    /// user review, never injected) instead of being dropped silently
    /// (myne-md/myne#709, `decisions/ai/0591`). Carries no detail: the scan's
    /// classes are closed and the memory UI renders the entry as rejected or
    /// held.
    #[error("the memory write failed the injection scan or the schema gate")]
    MemoryScanRejected,
    /// A `remember` action named a user-authored entry (myne-md/myne#709, the
    /// authorship gate). The model never overwrites user rows; the correction
    /// stays a user act in the Memory panel. A refusal the loop reports, not
    /// a run failure.
    #[error("the agent may not overwrite a user-authored memory entry")]
    MemoryAuthorshipRefused,
    /// A `remember` action distilled notes the run read from a folder the user
    /// has since excluded (myne-md/myne#709, write-time exclusion). A refusal
    /// the loop reports, not a run failure.
    #[error("the memory was learned from a note in an excluded folder")]
    MemoryExcludedSource,
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
    /// The provider rejected the request itself (HTTP 400), rather than the
    /// credential or the cost (myne-md/myne#547).
    #[error("the provider rejected the request")]
    ProviderRejected,
    /// The backend failed for some other reason.
    ///
    /// Both of these exist because [`AgentError::ReadFailed`] was carrying two
    /// unrelated meanings: a note that could not be decrypted, and ANY engine
    /// failure, via `agent_error_of`'s catch-all. So a provider refusing a
    /// request reached the user as "the note could not be read", which sends
    /// them to look at their vault for a fault in the request Myne built.
    #[error("the backend failed")]
    ProviderFailed,
    /// A GATE refused the request: the user has not agreed to send to this
    /// provider, AI is off, no credential is stored, or the backend is not
    /// ready.
    ///
    /// **One variant per gate would be four; one variant carrying the cause is
    /// one, and the cause is what a surface needs** (myne-md/myne#456, found by
    /// review). Every gate refusal used to collapse into `ProviderFailed`, so
    /// the phone that inherited a provider and a key and holds no local consent,
    /// which is exactly the population the device-scoped consent creates, was
    /// told "That did not work. Nothing was saved and nothing was sent again."
    /// rather than the sentence that names the fix. `AiChatFlow`'s
    /// `GATE_REFUSALS` branch could not fire at all, and deleting it would have
    /// changed nothing.
    ///
    /// This is the defect `EngineError` splits `ConsentMissing` out of
    /// `RemoteBarred` to fix, one layer down: that split reached the desktop
    /// `local_inference` path and not the only path mobile has.
    #[error("a gate refused the request: {cause}")]
    GateRefused {
        /// The `EngineError::kind()` of the refusing gate, which is bounded and
        /// content-free by construction, so it is safe to log and safe to send
        /// across IPC.
        cause: &'static str,
    },
}

impl AgentError {
    /// Bounded, content-free tag for structured logging.
    ///
    /// Mirrors `EngineError::kind` and exists for the same reason: several
    /// variants carry a `note_id`, so a `Debug` format of this value in a log
    /// line would put a note identifier on disk. The DENY list in
    /// `src-tauri/AGENTS.md` names `note_id` explicitly. A caller logs this;
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
            Self::MemoryScanRejected => "memory_scan_rejected",
            Self::MemoryAuthorshipRefused => "memory_authorship_refused",
            Self::MemoryExcludedSource => "memory_excluded_source",
            Self::RootGrant => "root_grant",
            Self::RestorePointFailed => "restore_point_failed",
            Self::WriteFailed => "write_failed",
            Self::ReadFailed => "read_failed",
            Self::EditFormatUnsupported => "edit_format_unsupported",
            Self::IndividualApprovalNotSingle => "individual_approval_not_single",
            Self::StepAlreadyRunning => "step_already_running",
            Self::ProviderRejected => "provider_rejected",
            Self::ProviderFailed => "provider_failed",
            Self::GateRefused { .. } => "gate_refused",
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
