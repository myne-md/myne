// SPDX-License-Identifier: AGPL-3.0
//! Recognising the one edit that is a deletion in disguise.
//!
//! The verb set has no delete in it, and it does not need one: trash in Myne is
//! a `trashed:` frontmatter timestamp, so trashing a note is an ordinary body
//! edit and is reversible. That is the right shape for the vocabulary, and it
//! creates one hazard at the review surface: **at the diff layer, trashing a
//! note is indistinguishable from any other edit.** Left alone, "the agent can
//! only edit bodies, nothing destructive" quietly becomes "a silent trash inside
//! a forty-edit approve-all".
//!
//! So the bulk approve is not allowed to carry one, and this module is how the
//! host tells. It promotes
//! [`crate::plugins::notes::daily_match::fm_trashed_value_strict`] from a
//! display helper to a control the exclusion depends on, which is why that
//! function's **both** behaviours are pinned by the tests below: that a real
//! timestamp is detected, and that a user's own non-timestamp `trashed:` value
//! is still not treated as a trash marker. Testing only the new case is how a
//! fix closes one blind spot and opens another.

use crate::plugins::notes::daily_match::fm_trashed_value_strict;
use crate::plugins::notes::title_extract::extract_title_slices;

/// Whether a note carries a live trash marker.
fn is_trashed(body: &str) -> bool {
    match extract_title_slices(body.as_bytes()).frontmatter_bytes {
        Some(fm) => fm_trashed_value_strict(fm).is_some(),
        None => false,
    }
}

/// Whether applying this edit would move a note INTO the trash.
///
/// Directional on purpose. Untrashing (removing the marker) is a restore, not a
/// destruction, and holding it to the same separate-act rule would make
/// recovering from a mistaken trash harder than making one.
pub fn edit_trashes(before: &str, after: &str) -> bool {
    !is_trashed(before) && is_trashed(after)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TS: &str = "2026-08-16T10:00:00Z";

    fn note(fm: &str) -> String {
        format!("---\n{fm}\n---\n\nbody text\n")
    }

    #[test]
    fn an_edit_that_adds_a_trash_timestamp_is_recognised() {
        let before = note("title: T");
        let after = note(&format!("title: T\ntrashed: {TS}"));
        assert!(edit_trashes(&before, &after));
    }

    #[test]
    fn an_ordinary_edit_is_not_a_trash() {
        let before = note("title: T");
        let after = note("title: T2");
        assert!(!edit_trashes(&before, &after));
    }

    #[test]
    fn a_body_only_edit_is_not_a_trash() {
        let before = note("title: T");
        let after = format!("{}\nmore text\n", note("title: T"));
        assert!(!edit_trashes(&before, &after));
    }

    // The pre-existing behaviour, pinned. `fm_trashed_value_strict` is
    // value-strict: a user's own `trashed: true` is not a marker. This is the
    // direction a fix aimed at the new case is most likely to break.
    #[test]
    fn a_users_own_non_timestamp_trashed_value_is_still_not_a_marker() {
        let before = note("title: T");
        for v in ["true", "yes", "soon", "\"\"", "2026-13-45T99:99:99Z"] {
            let after = note(&format!("title: T\ntrashed: {v}"));
            assert!(
                !edit_trashes(&before, &after),
                "value-strict must reject {v:?}"
            );
        }
    }

    #[test]
    fn untrashing_is_not_treated_as_a_trash() {
        let before = note(&format!("title: T\ntrashed: {TS}"));
        let after = note("title: T");
        assert!(
            !edit_trashes(&before, &after),
            "restoring is not destroying"
        );
    }

    #[test]
    fn a_note_that_was_already_trashed_and_stays_so_is_not_a_new_trash() {
        let before = note(&format!("title: T\ntrashed: {TS}"));
        let after = note(&format!("title: T2\ntrashed: {TS}"));
        assert!(!edit_trashes(&before, &after));
    }

    #[test]
    fn a_note_with_no_frontmatter_at_all_is_handled_rather_than_panicking() {
        assert!(!edit_trashes("just text", "just more text"));
        assert!(edit_trashes("just text", &note(&format!("trashed: {TS}"))));
    }
}
