// SPDX-License-Identifier: AGPL-3.0
//! The anchored edit format: exact match, exactly once, or refused.
//!
//! An edit is a pair of (exact existing text, replacement text) against one
//! note. The host requires the anchor to occur **exactly once** in the note.
//! Zero occurrences and more than one are separate named refusals, and neither
//! is ever resolved by placing the replacement somewhere plausible.
//!
//! **"Occurs" counts OVERLAPPING occurrences.** `str::match_indices` does not:
//! it resumes the search after each match, so `"aa"` occurs once in `"aaa"` by
//! its count and twice by the rule this module states. That gap is a silent
//! placement of an edit the format promises to refuse, which is the one failure
//! class the anchored format exists to prevent, so the count is done by hand.
//! Rare in practice (anchors are long spans copied out of a body) and the point
//! is not the frequency: a rule with an exception nobody stated is not the rule.
//! Found in review round five of myne-md/myne#531.
//!
//! **There is no fuzzy matching here and there must never be one.** Not a
//! nearest-match fallback, not a whitespace-tolerant retry, not a "try again
//! without the trailing newline". Every one of those looks like an ergonomics
//! improvement and every one of them converts a visible refusal into a silent
//! misapplication, which is the single failure class this format exists to
//! prevent. A model that copies anchors badly is a model that shows agent mode
//! as unavailable ([`super::probe`]), not a model this module accommodates.
//!
//! **[`place`] is the whole rule and the only entry point.** There is no
//! sequential multi-edit helper here: the apply path owns that loop, because it
//! is the one that also has to report a per-edit outcome with the index the user
//! looked at. A second implementation living here would be a second place the
//! overlap semantics could be right, tested in the place production does not
//! call.
//!
//! **The sync race is answered here rather than by a lock.** Anchors are
//! content-addressed, so an edit whose note changed between the model reading it
//! and the user approving simply does not match, and is refused by the ordinary
//! rule with no special-case code path. An offset-based or line-based encoding
//! would instead apply to whatever now sits at that position.

use super::error::EditRejection;
use serde::{Deserialize, Serialize};

/// One proposed edit against one note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedEdit {
    /// The note this edit applies to.
    pub note_id: String,
    /// The exact existing text the model copied out of the note.
    pub anchor: String,
    /// What replaces it. An empty replacement is a deletion of the anchor, which
    /// is ordinary and allowed; it is the review surface's job to flag a large
    /// net deletion, not this module's to refuse one.
    pub replacement: String,
}

/// Place one anchored replacement into a body.
///
/// The whole rule, in one function, so there is one place to read and one place
/// to break when verifying it.
pub fn place(body: &str, anchor: &str, replacement: &str) -> Result<String, EditRejection> {
    if anchor.is_empty() {
        // An empty anchor matches at every position, so "exactly once" would be
        // vacuously false for any non-empty body and vacuously true for an empty
        // one. Naming it is better than letting the count rule decide.
        return Err(EditRejection::AnchorEmpty);
    }
    // Overlapping, by stepping one CHARACTER at a time rather than one match:
    // see the module doc. `char_indices` rather than a byte walk so a resume
    // point is always a char boundary and `find` cannot panic on a slice.
    let mut found: Option<usize> = None;
    for (at, _) in body.char_indices() {
        if !body[at..].starts_with(anchor) {
            continue;
        }
        if found.is_some() {
            return Err(EditRejection::AnchorAmbiguous);
        }
        found = Some(at);
    }
    let Some(first) = found else {
        return Err(EditRejection::AnchorNotFound);
    };
    let mut out = String::with_capacity(body.len() - anchor.len() + replacement.len());
    out.push_str(&body[..first]);
    out.push_str(replacement);
    out.push_str(&body[first + anchor.len()..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exactly_one_match_applies() {
        assert_eq!(place("a b c", "b", "B").unwrap(), "a B c");
    }

    #[test]
    fn zero_matches_is_its_own_named_cause() {
        assert_eq!(
            place("a b c", "zzz", "X").unwrap_err(),
            EditRejection::AnchorNotFound
        );
    }

    #[test]
    fn more_than_one_match_is_a_different_named_cause() {
        assert_eq!(
            place("a b a", "a", "X").unwrap_err(),
            EditRejection::AnchorAmbiguous
        );
    }

    /// The overlap case, which `str::match_indices` counts as one.
    ///
    /// `"aa"` occurs twice in `"aaa"` — at 0 and at 1 — so the exactly-once rule
    /// refuses it. The shipped version counted one and placed the replacement at
    /// the first position, which is the silent misapplication this format is the
    /// whole answer to.
    #[test]
    fn an_overlapping_anchor_is_ambiguous_rather_than_placed_at_the_first_one() {
        assert_eq!(
            place("aaa", "aa", "X").unwrap_err(),
            EditRejection::AnchorAmbiguous
        );
        assert_eq!(
            place("abababa", "abab", "X").unwrap_err(),
            EditRejection::AnchorAmbiguous
        );
        // And the non-overlapping neighbour still places, so the fix did not
        // simply make every repeated character ambiguous.
        assert_eq!(place("aa", "aa", "X").unwrap(), "X");
        assert_eq!(place("a-aa-a", "aa", "X").unwrap(), "a-X-a");
    }

    /// Multi-byte input, because the walk is over char boundaries now.
    #[test]
    fn overlap_counting_holds_across_a_multi_byte_body() {
        assert_eq!(place("üü", "üü", "X").unwrap(), "X");
        assert_eq!(
            place("üüü", "üü", "X").unwrap_err(),
            EditRejection::AnchorAmbiguous
        );
        assert_eq!(place("añb", "ñ", "X").unwrap(), "aXb");
    }

    #[test]
    fn an_empty_anchor_is_refused_rather_than_matching_everywhere() {
        assert_eq!(
            place("a b c", "", "X").unwrap_err(),
            EditRejection::AnchorEmpty
        );
        assert_eq!(place("", "", "X").unwrap_err(), EditRejection::AnchorEmpty);
    }

    // The near-miss case, which is the one that decides whether this format is
    // worth anything. One character off must REFUSE, not place.
    #[test]
    fn a_near_miss_anchor_is_refused_not_fuzzily_placed() {
        let body = "The quick brown fox";
        assert_eq!(
            place(body, "The quick browm fox", "X").unwrap_err(),
            EditRejection::AnchorNotFound
        );
        // Whitespace differences are also misses, deliberately.
        assert_eq!(
            place(body, "The  quick brown fox", "X").unwrap_err(),
            EditRejection::AnchorNotFound
        );
        assert_eq!(
            place(body, "the quick brown fox", "X").unwrap_err(),
            EditRejection::AnchorNotFound
        );
    }

    // The sync race, through the ordinary rule and no special path.
    #[test]
    fn an_edit_against_a_body_that_moved_is_refused_by_the_same_rule() {
        let read_by_the_model = "alpha beta gamma";
        let anchor = "beta";
        // Something else rewrote the note between the read and the approval.
        let now_on_disk = "alpha BETA gamma";
        assert!(place(read_by_the_model, anchor, "X").is_ok());
        assert_eq!(
            place(now_on_disk, anchor, "X").unwrap_err(),
            EditRejection::AnchorNotFound
        );
    }

    #[test]
    fn an_empty_replacement_is_a_deletion_and_is_allowed() {
        assert_eq!(place("a b c", " b", "").unwrap(), "a c");
    }

    #[test]
    fn multibyte_anchors_do_not_split_a_character() {
        // A byte-index slice through a multi-byte char would panic; the
        // match_indices boundaries are char-aligned, and this is the test that
        // says so rather than trusting it.
        assert_eq!(place("önce sonra", "önce", "ilk").unwrap(), "ilk sonra");
        assert_eq!(place("a 🙂 b", "🙂", "X").unwrap(), "a X b");
    }
}
