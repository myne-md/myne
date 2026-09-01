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
use crate::plugins::notes::title_extract::{body_after_frontmatter, extract_title_slices};
use serde::{Deserialize, Serialize};

/// Which shape of write this edit is.
///
/// **A discriminator on the existing type rather than a second list on the
/// proposal, and that placement is the design.** The removal carve-out, the
/// bulk-approval split, the not-proposed check, the undo restore point and the
/// review screen are all keyed on `Proposal::edits`; a parallel `appends` list
/// would mean re-deriving five checks by hand, and `hide.rs` exists because one
/// of those checks was once incomplete. Here, an append inherits every one of
/// them by construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum EditKind {
    /// Replace [`ProposedEdit::anchor`] with [`ProposedEdit::replacement`].
    #[default]
    Replace,
    /// Append [`ProposedEdit::replacement`] to the end of the note's body.
    /// [`ProposedEdit::anchor`] is unused and must be empty.
    Append,
}

/// One proposed edit against one note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedEdit {
    /// The note this edit applies to.
    pub note_id: String,
    /// Replace or append. `#[serde(default)]` so a payload written before the
    /// append verb existed still deserializes as the replace it was.
    #[serde(default)]
    pub kind: EditKind,
    /// The exact existing text the model copied out of the note. Empty for an
    /// append, where there is nothing to anchor to.
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

/// Append `text` to a note's body.
///
/// **The verb that makes "write this into the note" possible at all.** An
/// anchored edit needs text copied out of the note, occurring exactly once, and
/// an empty anchor is refused by [`place`], so before this existed there was no
/// way to write into an empty note: the request failed for a structural reason
/// no message explained. Appending to a long note was possible but expensive
/// and brittle, since the model had to anchor on the whole tail and reproduce
/// it verbatim.
///
/// ## The append lands after the frontmatter, always
///
/// This is what stops an append from authoring frontmatter. The body region is
/// located with [`body_after_frontmatter`], the same scan the folder clamp uses,
/// and the text goes at the end of THAT rather than at the end of the file. In
/// a note that has a frontmatter block, appended text therefore cannot be the
/// first line, whatever it starts with.
///
/// Positioning alone does not close it, though, and the precondition this doc
/// used to state ("a note with NO frontmatter block and no body") was the wrong
/// one. A note with no frontmatter whose body merely BEGINS with `---` has an
/// opener nothing has closed, so appended text containing an ordinary `---`
/// separator closes it and the user's own first lines become a frontmatter
/// block. So the check is on the RESULT rather than on the shape of the input:
/// an append that gives the note a frontmatter block it did not have is
/// refused. That is the rule [`crate::plugins::agent::apply`] already applies
/// twice, in `edit_moves_note` and `edit_hides_note`, both of which compare
/// before against after rather than inspecting the replacement. Refused rather
/// than mangled, because silently rewriting the model's text would leave the
/// user approving something nobody wrote.
///
/// ## Separation
///
/// Trailing newlines on the existing body are normalised away and exactly one
/// blank line is inserted, so an append reads as a new block rather than
/// running into the last paragraph. In markdown a missing blank line is not
/// cosmetic: it makes the appended text part of the preceding paragraph.
///
/// The empty-body case needs the same care on the HEAD side, and that is not
/// symmetry for its own sake. [`crate::plugins::notes::title_extract`] accepts
/// a closing `---` that ends the file with no newline after it, so a note can
/// legitimately arrive whose head does not end in `\n` and whose body region is
/// empty. Pushing the text straight after that head glues it onto the closer
/// line, the closer stops closing, and the whole block ceases to be
/// frontmatter: `title:`, `folder:`, tags and task fields all become one
/// malformed body line. Normalising here is what makes the two spellings of
/// the same note append identically.
pub fn append(body: &str, text: &str) -> Result<String, EditRejection> {
    if text.trim().is_empty() {
        return Err(EditRejection::AppendEmpty);
    }
    // `body_after_frontmatter` returns the body SLICE; the difference in length
    // is where it begins, and that boundary is always just past a `\n`, so the
    // split cannot land inside a character.
    let rest = body_after_frontmatter(body.as_bytes());
    let head_len = body.len() - rest.len();
    let (head, tail) = body.split_at(head_len);
    let tail = tail.trim_end_matches('\n');
    let text = text.trim_end_matches('\n');

    let mut out = String::with_capacity(body.len() + text.len() + 2);
    out.push_str(head);
    if !head.is_empty() && !head.ends_with('\n') {
        // A frontmatter closer that ends the file with no newline after it.
        // Without this the text lands ON the closer line and unmakes the block.
        out.push('\n');
    }
    if !tail.is_empty() {
        out.push_str(tail);
        out.push_str("\n\n");
    }
    out.push_str(text);
    out.push('\n');

    // The result check. An append writes BODY text, so whether the note has a
    // frontmatter block is not its to change. The gaining direction is the one
    // an untrusted replacement can force, and it is refused here; the losing
    // direction is our own head handling and is pinned by test instead, since a
    // refusal named `AppendWouldWriteFrontmatter` would be the wrong sentence to
    // show a user whose frontmatter we had just destroyed.
    let had_frontmatter = extract_title_slices(body.as_bytes())
        .frontmatter_bytes
        .is_some();
    let has_frontmatter = extract_title_slices(out.as_bytes())
        .frontmatter_bytes
        .is_some();
    if has_frontmatter && !had_frontmatter {
        return Err(EditRejection::AppendWouldWriteFrontmatter);
    }

    Ok(out)
}

/// Apply one proposed edit, whichever shape it is.
///
/// The single entry point the apply path calls, so a new edit kind is one arm
/// here rather than a second call site to keep in step.
pub fn apply_edit(body: &str, edit: &ProposedEdit) -> Result<String, EditRejection> {
    match edit.kind {
        EditKind::Replace => place(body, &edit.anchor, &edit.replacement),
        EditKind::Append => append(body, &edit.replacement),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- the two frontmatter hazards positioning alone does not close ----
    //
    // Both were found by the myne-md/myne#622 review and both are the same
    // question asked at the wrong end: `append` used to reason about its INPUT
    // (is the head empty, does the text open with `---`) when what matters is
    // the RESULT. `apply.rs` already learned this twice, in `edit_moves_note`
    // and `edit_hides_note`, which compare before against after rather than
    // inspecting the replacement.

    #[test]
    fn append_to_a_closer_without_a_trailing_newline_keeps_the_frontmatter() {
        // `scan_frontmatter` accepts a closing `---` that ends the file with no
        // newline after it, so the body region is empty AND the head does not
        // end in `\n`. Pushing the text straight after the head glued it onto
        // the closer line, which stops being a closer: the whole block ceases
        // to be frontmatter and `title:`, `folder:`, tags and task fields all
        // become one malformed body line.
        let without_nl = append("---\ntitle: Real Title\n---", "the list").unwrap();
        let with_nl = append("---\ntitle: Real Title\n---\n", "the list").unwrap();
        // The two spellings of the same note are the same note, so they append
        // identically. Asserting convergence rather than a literal is what makes
        // this a property instead of a transcription of today's output.
        assert_eq!(without_nl, with_nl);
        assert!(
            extract_title_slices(without_nl.as_bytes())
                .frontmatter_bytes
                .is_some(),
            "append destroyed the frontmatter block: {without_nl:?}"
        );
    }

    #[test]
    fn append_may_not_turn_existing_body_text_into_frontmatter() {
        // A note with no frontmatter whose body merely BEGINS with `---\n`.
        // Nothing has closed that opener, so appending text containing a `---`
        // line closes it, and the user's own first lines become a frontmatter
        // block that stops rendering. A `---` separator is ordinary in
        // model-written markdown, so this is not an exotic input.
        let before = "---\nmy shopping list\nmilk\n";
        assert!(extract_title_slices(before.as_bytes())
            .frontmatter_bytes
            .is_none());
        assert_eq!(
            append(before, "## Summary\n\n---\n\ndone").unwrap_err(),
            EditRejection::AppendWouldWriteFrontmatter
        );
    }

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

    // ---- append ---------------------------------------------------------

    const FM: &str = "---\ntitle: A\nfolder: Work\n---\n";

    /// The case the whole verb exists for: before it, this was impossible, and
    /// the failure had no message that explained itself.
    #[test]
    fn an_append_into_an_empty_body_writes_the_text() {
        // `{FM}\n` is a frontmatter block followed by the blank line a note
        // carries between it and the body. `body_after_frontmatter` counts that
        // separator as part of the head, so it survives and the text lands
        // directly after it.
        let out = append(&format!("{FM}\n"), "hello").unwrap();
        assert_eq!(out, format!("{FM}\nhello\n"));
    }

    /// And with no separator line at all, which is the tighter shape.
    #[test]
    fn an_append_into_a_note_that_is_only_frontmatter_writes_the_text() {
        let out = append(FM, "hello").unwrap();
        assert_eq!(out, format!("{FM}hello\n"));
    }

    #[test]
    fn an_append_into_an_existing_body_leaves_it_byte_identical() {
        let before = format!("{FM}first paragraph\n");
        let out = append(&before, "second").unwrap();
        assert_eq!(out, format!("{FM}first paragraph\n\nsecond\n"));
        assert!(out.starts_with(&before[..before.len() - 1]));
    }

    /// A missing blank line is not cosmetic in markdown: it makes the appended
    /// text part of the preceding paragraph.
    #[test]
    fn exactly_one_blank_line_separates_the_append_however_the_body_ended() {
        for tail in ["body", "body\n", "body\n\n", "body\n\n\n"] {
            let out = append(&format!("{FM}{tail}"), "next").unwrap();
            assert_eq!(out, format!("{FM}body\n\nnext\n"), "{tail:?}");
        }
    }

    /// The structural half of the frontmatter protection: with a block in
    /// front, appended text cannot be line one whatever it starts with.
    #[test]
    fn an_append_lands_after_the_frontmatter_not_at_the_end_of_the_file() {
        let out = append(&format!("{FM}\n"), "---\nfolder: Secrets\n---").unwrap();
        assert!(
            out.starts_with(FM),
            "the note's own frontmatter must still be the first thing in the file"
        );
        assert!(
            out.contains("---\nfolder: Secrets\n---"),
            "and the model's text is preserved verbatim rather than mangled"
        );
    }

    /// The one case positioning cannot cover, refused rather than mangled.
    #[test]
    fn an_append_that_would_author_frontmatter_in_a_bare_note_is_refused() {
        assert_eq!(
            append("", "---\nfolder: Secrets\n---\n").unwrap_err(),
            EditRejection::AppendWouldWriteFrontmatter
        );
    }

    /// The same text into a bare note that already has a body is fine: it
    /// cannot be line one, so it cannot be frontmatter.
    #[test]
    fn the_same_text_into_a_bare_note_with_a_body_is_allowed() {
        let out = append("existing\n", "---\nnot: frontmatter\n---").unwrap();
        assert!(out.starts_with("existing\n\n---"));
    }

    #[test]
    fn an_empty_append_is_refused_by_its_own_name() {
        for text in ["", "   ", "\n\n"] {
            assert_eq!(
                append("body\n", text).unwrap_err(),
                EditRejection::AppendEmpty,
                "{text:?}"
            );
        }
    }

    #[test]
    fn append_does_not_split_a_multibyte_character() {
        let out = append("önce\n", "sonra 🙂").unwrap();
        assert_eq!(out, "önce\n\nsonra 🙂\n");
    }

    /// The dispatcher routes by kind and nothing else, so a `replace` carrying
    /// an anchor still goes through the anchored rule.
    #[test]
    fn apply_edit_routes_on_the_kind() {
        let replace = ProposedEdit {
            note_id: "n".into(),
            kind: EditKind::Replace,
            anchor: "a".into(),
            replacement: "b".into(),
        };
        assert_eq!(apply_edit("x a y", &replace).unwrap(), "x b y");

        let append_edit = ProposedEdit {
            note_id: "n".into(),
            kind: EditKind::Append,
            anchor: String::new(),
            replacement: "b".into(),
        };
        assert_eq!(apply_edit("x\n", &append_edit).unwrap(), "x\n\nb\n");
    }

    /// A payload written before the verb existed deserializes as the replace it
    /// was, which is what `#[serde(default)]` is there for.
    #[test]
    fn an_edit_without_a_kind_field_deserializes_as_a_replace() {
        let json = r#"{"noteId":"n","anchor":"a","replacement":"b"}"#;
        let edit: ProposedEdit = serde_json::from_str(json).unwrap();
        assert_eq!(edit.kind, EditKind::Replace);
    }
}
