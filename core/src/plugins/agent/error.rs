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
    /// The edit would move a note to Trash, and it arrived inside a batch the
    /// user approved in one action.
    ///
    /// Trashing is a `trashed:` frontmatter timestamp, so at the diff layer it
    /// is indistinguishable from any other edit; this is the host refusing to
    /// let one ride along inside an approve-all. The user can still apply it,
    /// by approving it on its own.
    TrashNeedsOwnAct,
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
