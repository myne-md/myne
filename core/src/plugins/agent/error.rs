// SPDX-License-Identifier: AGPL-3.0
//! `agent` plugin core error taxonomy.
//!
//! Two closed, `serde::Serialize` enums, DENY-list clean per
//! `src-tauri/AGENTS.md` "Secret-handling logging discipline": no note ids in a
//! `Display` string, no paths, no plaintext. `note_id` appears as a structured
//! field only where the frontend already holds the id it sent.
//!
//! One enum rather than one per command: the agent commands share a single
//! failure surface, and splitting it would make the TS mirror five near-identical
//! unions.

use serde::Serialize;
use thiserror::Error;

/// Why an edit the model proposed could not be placed.
///
/// A *result*, not only an error: a proposal routinely carries placeable and
/// unplaceable edits together, and the unplaceable ones are shown with their
/// cause rather than dropped. See [`super::edit::place`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditRejection {
    /// The anchor text does not occur in the note: either the model invented it
    /// or the note changed since it was read. Deliberately not distinguished —
    /// the host cannot tell them apart, and a guess would be a claim it cannot
    /// support.
    AnchorNotFound,
    /// The anchor occurs more than once, so where the replacement lands is
    /// undetermined. Never resolved by taking the first match.
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
    /// Distinct from `OutOfScope`, which is about the run's frozen grant: this
    /// one fires for a note the user DID grant and then excluded, or moved into
    /// an excluded folder, while the run was open or the review was pending.
    /// SYNC-14 carries no in-flight carve-out, so the newest answer decides.
    ExcludedNow,
    /// The proposed new note names an `ai_excluded_folders` folder. A new note's
    /// folder comes from the model, so it is the one write whose destination the
    /// scope clamp cannot cover — a note that does not exist yet is in no scope.
    ExcludedFolder,
    /// The proposed new note could not be written.
    ///
    /// **A cause rather than a propagated error.** A create runs LAST, after the
    /// batch is committed and after the restore point was taken; returning `Err`
    /// there discarded the whole `ApplyOutcome`, restore points included, so the
    /// edits stayed on disk with no undo record while the surface said nothing
    /// had been applied.
    CreateFailed,
    /// The edit is not one the host recorded the model proposing.
    ///
    /// The edits arrive from the IPC payload as free strings, unlike the new
    /// notes, which are selected by index into the host's own record. Not a TB6
    /// widening — a WebView that can send this already holds the notes ACL — but
    /// the run record would otherwise describe writes the model never proposed,
    /// presented to the user as one action (myne-md/myne#531).
    NotProposed,
    /// The edit would take a note OUT of the working set, inside a batch the user
    /// approved in one action.
    ///
    /// Every removal in Myne is a frontmatter field — `trashed:`, `deleted:`,
    /// `archived:`, `template:`, `conflict:` — so at the diff layer it is
    /// indistinguishable from any other edit; this is the host refusing to let
    /// one ride along inside an approve-all. The user can still apply it on its
    /// own. [`super::hide::edit_hides_note`] is the predicate and carries the
    /// roster; named for the class rather than for `trashed:` because a
    /// `deleted:` edit hides a note from Trash too and slipped the carve-out
    /// when the variant read one field (myne-md/myne#531).
    RemovalNeedsOwnAct,
    /// The edit would move the note to a different folder.
    ///
    /// `folder:` is what the `ai_excluded_folders` clamp reads, and the clamp
    /// runs against the note as it was BEFORE the batch, so an edit spanning that
    /// line could move a note into an excluded folder with no control seeing it.
    /// Refused under every approval label, because no user act makes an
    /// agent-chosen folder move correct — unlike [`Self::RemovalNeedsOwnAct`],
    /// which fires only inside a bulk approval. Deliberately narrower than "the
    /// frontmatter changed": `title:` and note properties are fields the agent
    /// legitimately edits. [`super::frontmatter::edit_moves_note`] carries that
    /// argument.
    NoteMoved,
    /// An append carried nothing to append. Its own reason rather than
    /// [`Self::AnchorEmpty`], which would be a false sentence — an append has no
    /// anchor by design.
    AppendEmpty,
    /// A move asked for the folder the note is already in.
    ///
    /// Its own reason rather than a silent success: destinations are compared
    /// canonically, so `Work` -> `work/` is the same folder, and letting it
    /// through would rewrite the note's bytes and bump its sync version for no
    /// change. Naming it also gives the review screen a sentence instead of a row
    /// that looks applied.
    MoveToSameFolder,
    /// A move's destination is an `ai_excluded_folders` folder — the second half
    /// of the two-way clamp. The note's CURRENT folder is checked before the
    /// batch runs ([`Self::ExcludedNow`]), which refuses leaving an excluded
    /// folder; distinct from [`Self::ExcludedFolder`], which has no current
    /// folder to compare against.
    MoveIntoExcludedFolder,
    /// A move's destination is not a folder this vault has.
    ///
    /// **The model may not invent a folder** (myne-md/myne#913): the catalog is
    /// the user's own structure, and a destination the model made up is a silent
    /// second structure that nothing reported, because a `folder:` value IS the
    /// folder. Compared canonically against the host's set (index plus the
    /// deliberate empty folders), so case and trailing slashes do not matter and
    /// a user-created empty folder is a real destination. Naming a folder is a
    /// user act, never a side effect of a proposal.
    UnknownFolder,
    /// An append into a note with neither a frontmatter block nor a body would
    /// have authored one. Appended text normally lands after the frontmatter,
    /// which makes being first structurally impossible; with an entirely empty
    /// note there is nothing to anchor on, and mangling the model's text would
    /// leave the user approving something nobody wrote.
    AppendWouldWriteFrontmatter,
}

/// The agent plugin's failure surface.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum AgentError {
    /// Vault not unlocked when the command ran.
    #[error("vault is not unlocked")]
    SlotNotUnlocked,
    /// No run with that id: it finished, or the vault locked and took it with it
    /// (which is the design, not a fault).
    #[error("no such agent run")]
    NoSuchRun,
    /// AI is switched off for this vault.
    ///
    /// Read host-side from `vault.prefs`, never from the caller: the WebView
    /// hiding the surface is not a gate, and this is the one AI surface whose
    /// opt-in would otherwise live only in the page it constrains.
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
    /// folder, so the READ tool refused it. The read-side twin of
    /// [`EditRejection::ExcludedNow`], and distinct from `OutOfScope` for the
    /// same reason: the user DID grant this note and then excluded it while the
    /// run was open.
    #[error("note now sits in an excluded folder")]
    ExcludedNow,
    /// The grant resolved to nothing the run may use: every note in it was
    /// excluded, or the folder holds none.
    #[error("grant resolved to no usable notes")]
    EmptyGrant,
    /// A `remember` action failed the memory plugin's write-time gate (schema,
    /// 2000-character cap, injection scan; `decisions/ai/0590`).
    ///
    /// Refused at the write: a refused update or user write is never persisted; a
    /// refused MODEL create persists as `quarantined` — held for user review,
    /// never injected — rather than being dropped silently (myne-md/myne#709,
    /// `decisions/ai/0591`). Carries no detail: the scan's classes are closed and
    /// the memory UI renders the entry as rejected or held.
    #[error("the memory write failed the injection scan or the schema gate")]
    MemoryScanRejected,
    /// A `remember` action named a user-authored entry (myne-md/myne#709). The
    /// model never overwrites user rows; the correction stays a user act in the
    /// Memory panel. A refusal the loop reports, not a run failure.
    #[error("the agent may not overwrite a user-authored memory entry")]
    MemoryAuthorshipRefused,
    /// A `remember` action distilled notes the run read from a folder the user
    /// has since excluded (myne-md/myne#709). A refusal the loop reports, not a
    /// run failure.
    #[error("the memory was learned from a note in an excluded folder")]
    MemoryExcludedSource,
    /// A grant named a folder that canonicalizes to the vault root, which would
    /// grant the whole vault in one step.
    #[error("a grant may not name the vault root")]
    RootGrant,
    /// The run's restore point could not be taken, so the apply did not run.
    ///
    /// Not recoverable by continuing: the restore point is the only thing that
    /// makes an agent edit reversible, and the interface has already told the
    /// user the run can be undone.
    #[error("the run's restore point could not be taken, so nothing was written")]
    RestorePointFailed,
    /// The transactional write failed. Nothing partial landed, which is why this
    /// is one cause rather than a per-note report.
    #[error("writing the approved changes failed")]
    WriteFailed,
    /// Reading a note at apply time failed.
    #[error("reading a note failed")]
    ReadFailed,
    /// The configured backend cannot hold the anchored edit format, so agent mode
    /// is not offered on it.
    #[error("this model cannot produce the edit format agent mode needs")]
    EditFormatUnsupported,
    /// An apply labelled [`Approval::Individual`] carried more than one item.
    ///
    /// **The label is a fact about the click, so the host cannot derive it, but
    /// it must not carry an unbounded batch either.** The removal carve-out
    /// ([`super::hide::edit_hides_note`]) fires only inside an
    /// [`Approval::Bulk`], so without this an approve-all relabelled `individual`
    /// applied forty edits, tombstone included, in one act (myne-md/myne#531).
    ///
    /// Not derived from the count instead: approving a single remaining edit
    /// legitimately sends one item labelled `bulk`, and deriving would turn that
    /// into an individual approval and permit the removal the label refused.
    ///
    /// [`Approval::Individual`]: super::apply::Approval::Individual
    /// [`Approval::Bulk`]: super::apply::Approval::Bulk
    #[error("an individual approval may carry only one change")]
    IndividualApprovalNotSingle,
    /// A second step arrived while this run's model call is in flight.
    ///
    /// A step takes the run's transcript and proposal out of the session for the
    /// length of the call, so a concurrent second step would drive from an empty
    /// transcript and the later write-back would discard the other leg's work.
    /// Refused rather than serialised: the two legs answer different user
    /// actions, and running the second after the first answers it against a state
    /// the user never saw (myne-md/myne#531).
    #[error("this run is already working")]
    StepAlreadyRunning,
    /// The provider rejected the request itself (HTTP 400), rather than the
    /// credential or the cost (myne-md/myne#547).
    #[error("the provider rejected the request")]
    ProviderRejected,
    /// The backend failed for some other reason.
    ///
    /// Both of these exist because [`AgentError::ReadFailed`] was carrying two
    /// unrelated meanings — a note that could not be decrypted, and ANY engine
    /// failure via `agent_error_of`'s catch-all — so a provider refusing a
    /// request reached the user as "the note could not be read", sending them to
    /// look at their vault for a fault in the request Myne built.
    #[error("the backend failed")]
    ProviderFailed,
    /// A GATE refused: no consent for this provider, AI off, no credential
    /// stored, or the backend not ready.
    ///
    /// **One variant per gate would be four; one carrying the cause is one, and
    /// the cause is what a surface needs** (myne-md/myne#456). Every gate refusal
    /// used to collapse into `ProviderFailed`, so a phone that inherited a
    /// provider and a key without local consent was told "That did not work"
    /// instead of the sentence naming the fix, and `AiChatFlow`'s
    /// `GATE_REFUSALS` branch could not fire at all. This is the defect
    /// `EngineError` splits `ConsentMissing` out of `RemoteBarred` to fix, one
    /// layer down.
    #[error("a gate refused the request: {cause}")]
    GateRefused {
        /// The `EngineError::kind()` of the refusing gate: bounded and
        /// content-free by construction, so safe to log and safe across IPC.
        cause: &'static str,
    },
}

impl AgentError {
    /// Bounded, content-free tag for structured logging.
    ///
    /// Mirrors `EngineError::kind` and exists for the same reason: several
    /// variants carry a `note_id`, so a `Debug` format of this value would put a
    /// note identifier on disk, and the DENY list names `note_id` explicitly. A
    /// caller logs this; there is nothing else here safe to print.
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
}
