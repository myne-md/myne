// SPDX-License-Identifier: AGPL-3.0-only
//! Local-edit splice application (epic live-collab, `collab-editor-bridge` task 4).
//!
//! A CodeMirror transaction reports its changed ranges in **UTF-16 code units**
//! over the whole note; the authoritative Automerge `Text` (the `NC05` single
//! `Text`, `protocol.md` §10.7) is indexed by **Unicode scalar value**. This
//! module converts between the two at the boundary and applies the SMALLEST
//! possible `splice_text` per range, never a whole-body replace.
//!
//! # Why minimal splices, and why it is not just an optimisation
//!
//! A whole-body replace records "delete every character, then insert this whole
//! string"; when two devices each do that from a shared base, BOTH deletions and
//! BOTH insertions survive the merge and the note returns containing itself twice
//! (myne-md/myne#428). Applying the transaction's own ranges is a different,
//! merge-safe edit.
//!
//! # Why the conversion is load-bearing
//!
//! Forwarding a UTF-16 offset straight to Automerge lands at the wrong scalar
//! index the moment a surrogate pair (an emoji, a non-BMP character) precedes the
//! edit point. `an_edit_after_a_surrogate_pair_lands_at_the_right_scalar` pins it.
//!
//! The body-span clamp (the managed frontmatter is a reserved, non-spliced region,
//! `SYNC-14`) is the caller's: the editor bridge clamps before it sends, and the
//! reserved-region guard is `collab-editor-bridge` task 6.

use automerge::transaction::Transactable;
use automerge::{AutoCommit, ReadDoc};

use crate::plugins::notes::crdt::note_text_id;

/// A local-edit failure. Closed enum, no `String` field.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ApplyLocalError {
    /// A range endpoint fell inside a surrogate pair (not a character boundary).
    #[error("edit range is not on a character boundary")]
    NotOnCharBoundary,
    /// A range was inverted or two ranges overlapped.
    #[error("edit range is out of bounds")]
    OutOfBounds,
    /// The document is not a well-formed single-`Text` `NC05` document.
    #[error("live session document is malformed")]
    Malformed,
}

/// One local edit: replace the UTF-16 range `[from, to)` with `insert`. Offsets
/// are code units over the whole note (frontmatter included); the caller clamps
/// them to the body span before sending (`SYNC-14`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LocalSplice {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

/// The scalar index for a UTF-16 `offset`, or `None` if it is not on a character
/// boundary (or past the end).
fn utf16_to_scalar(s: &str, offset: usize) -> Option<usize> {
    let mut u16_units = 0usize;
    for (scalar, c) in s.chars().enumerate() {
        if u16_units == offset {
            return Some(scalar);
        }
        u16_units += c.len_utf16();
    }
    // The end-of-string offset is a valid boundary.
    (u16_units == offset).then(|| s.chars().count())
}

/// Apply `splices` to the document's single `Text` as minimal `splice_text`
/// operations and commit under `now_millis`. Ranges are applied DESCENDING by
/// `from` so earlier scalar offsets stay valid; they must be disjoint.
pub fn apply_local_splices(
    doc: &mut AutoCommit,
    now_millis: u64,
    splices: &[LocalSplice],
) -> Result<(), ApplyLocalError> {
    if splices.is_empty() {
        return Ok(());
    }
    let text = note_text_id(doc).map_err(|_| ApplyLocalError::Malformed)?;
    let current = doc.text(&text).map_err(|_| ApplyLocalError::Malformed)?;

    // Resolve every range against the CURRENT text (before any splice shifts it).
    let mut resolved: Vec<(usize, usize, &str)> = Vec::with_capacity(splices.len());
    for s in splices {
        let from = utf16_to_scalar(&current, s.from).ok_or(ApplyLocalError::NotOnCharBoundary)?;
        let to = utf16_to_scalar(&current, s.to).ok_or(ApplyLocalError::NotOnCharBoundary)?;
        if from > to {
            return Err(ApplyLocalError::OutOfBounds);
        }
        resolved.push((from, to, s.insert.as_str()));
    }
    // Descending by `from` keeps earlier offsets valid as later splices are applied.
    resolved.sort_by_key(|r| std::cmp::Reverse(r.0));
    // Ranges must be disjoint (a transaction's ranges are); overlap would corrupt.
    for w in resolved.windows(2) {
        if w[1].1 > w[0].0 {
            return Err(ApplyLocalError::OutOfBounds);
        }
    }
    for (from, to, insert) in resolved {
        // `splice_text`'s delete count is `isize`; the range is already bounded by
        // the document length, so the cast cannot wrap.
        doc.splice_text(&text, from, (to - from) as isize, insert)
            .map_err(|_| ApplyLocalError::Malformed)?;
    }
    crate::plugins::sync::crdt_doc::commit_at_millis(doc, now_millis);
    Ok(())
}
