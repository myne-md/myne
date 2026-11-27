// SPDX-License-Identifier: AGPL-3.0-only
//! Recognising the edits that are a removal in disguise.
//!
//! The verb set has no delete in it, and it does not need one: every way Myne
//! takes a note out of your note list is a **frontmatter field**, so doing it is
//! an ordinary body edit. That is the right shape for the vocabulary, and it
//! creates one hazard at the review surface: **at the diff layer, removing a
//! note is indistinguishable from any other edit.** Left alone, "the agent can
//! only edit bodies, nothing destructive" quietly becomes "a silent removal
//! inside a forty-edit approve-all".
//!
//! So the bulk approve is not allowed to carry one, and this module is how the
//! host tells.
//!
//! ## Why five fields and not one
//!
//! This module used to read `trashed:` and nothing else, and the review of
//! myne-md/myne#531 is what found that. `trashed:` is not the field class, it is
//! one member of it, and it is not even the worst one: a `trashed:` note is
//! still reachable in Trash, while a `deleted:` note is hidden from **every**
//! view there is — sidebar, Trash, Archive, search and the conflict resolver —
//! so the user cannot see what went and cannot get it back from the interface.
//! An approve-all carrying `deleted:` was strictly worse than the case the
//! carve-out was written for.
//!
//! The roster is therefore not hand-picked. It is exactly the fields
//! `isLiveNote` reads (`editor/src/host/notes/selectors.ts`), which is the one
//! authority for "this note is in the working set the sidebar shows":
//!
//! | Field | Shape | Where the note goes |
//! |---|---|---|
//! | `trashed:` | RFC 3339, value-strict | Trash |
//! | `deleted:` | RFC 3339, value-strict | nowhere — a sync tombstone, hidden from every view |
//! | `archived:` | RFC 3339, value-strict | Archive |
//! | `template:` | literal `true` | the template list |
//! | `conflict:` | literal `true` | the conflicts sheet |
//!
//! Naming the authority rather than the members is the point: the next field
//! that joins `isLiveNote` fails [`super::hide::tests::the_roster_matches_is_live_note`]
//! instead of silently becoming the sixth thing an approve-all can do.
//!
//! ## Per field, and directional
//!
//! The test is **not** `is_live(before) && !is_live(after)`, which is the
//! shape this reads like and is wrong: an already-archived note is not live, so
//! that version would let a bulk approve trash it. Each field is checked on its
//! own, so ADDING any marker is caught whatever the others say.
//!
//! Directional on purpose in the other direction too. Removing a marker is a
//! restore, not a destruction, and holding it to the same separate-act rule
//! would make recovering from a mistaken removal harder than making one.
//!
//! This module promotes five display helpers in
//! [`crate::plugins::notes::daily_match`] to controls the exclusion depends on,
//! which is why **both** of each helper's behaviours are pinned by the tests
//! below: that a real marker is detected, and that a user's own non-canonical
//! value (`trashed: true`, `template: "true"`) is still not treated as one.
//! Testing only the new case is how a fix closes one blind spot and opens
//! another.

use crate::plugins::notes::daily_match::{
    fm_archived_value_strict, fm_conflict_value_strict, fm_deleted_value_strict,
    fm_template_value_strict, fm_trashed_value_strict,
};
use crate::plugins::notes::title_extract::extract_title_slices;

/// Which of the working-set markers a note carries.
///
/// A fixed-width array rather than a struct of five fields so
/// [`edit_hides_note`] can compare the two sides in one loop and a sixth marker
/// is one line in one place.
type Markers = [bool; 5];

/// The working-set markers as FIELD NAMES, for a caller that has the name and not
/// the note: a write verb handed `field` has no body to read yet, and setting one of
/// these is how a note leaves the working set. Held to the TS authority by
/// [`tests::the_roster_matches_is_live_note`], so it cannot drift from [`markers`].
pub const WORKING_SET_FIELDS: [&str; 5] =
    ["trashed", "deleted", "archived", "template", "conflict"];

/// Read every working-set marker off a note body.
fn markers(body: &str) -> Markers {
    let Some(fm) = extract_title_slices(body.as_bytes()).frontmatter_bytes else {
        return [false; 5];
    };
    [
        fm_trashed_value_strict(fm).is_some(),
        fm_deleted_value_strict(fm).is_some(),
        fm_archived_value_strict(fm).is_some(),
        fm_template_value_strict(fm),
        fm_conflict_value_strict(fm),
    ]
}

/// Whether applying this edit would take a note OUT of the working set.
///
/// True iff the edit ADDS at least one of the markers in the module table.
/// See the module doc for why it is per field rather than a difference of
/// [`isLiveNote`], and why removing a marker is deliberately not caught.
pub fn edit_hides_note(before: &str, after: &str) -> bool {
    let (before, after) = (markers(before), markers(after));
    before
        .iter()
        .zip(after.iter())
        .any(|(was, now)| !was && *now)
}

/// Whether a whole note body is in the working set: the dry counterpart of
/// [`edit_hides_note`], over the same [`markers`] array.
///
/// One reader needs it for a note the sidebar's index does not carry yet: the
/// external MCP door answers a note id straight off the disk when the index has no
/// record (`plugins::mcp::host_adapters`), and a trashed, deleted, archived,
/// template or conflicted note must stay indistinguishable from a missing one. Not
/// a second rule: `isLiveNote` is the authority and
/// [`tests::the_roster_matches_is_live_note`] holds the roster to it.
pub fn body_is_live(body: &str) -> bool {
    !markers(body).iter().any(|carried| *carried)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const TS: &str = "2026-08-16T10:00:00Z";

    /// Every marker, as `(frontmatter line, human name)`. The tests below loop
    /// this rather than naming fields, so a marker added to [`markers`] without
    /// a test is a compile-time-visible omission rather than a silent one.
    const MARKER_LINES: [(&str, &str); 5] = [
        ("trashed: 2026-08-16T10:00:00Z", "trashed"),
        ("deleted: 2026-08-16T10:00:00Z", "deleted"),
        ("archived: 2026-08-16T10:00:00Z", "archived"),
        ("template: true", "template"),
        ("conflict: true", "conflict"),
    ];

    fn note(fm: &str) -> String {
        format!("---\n{fm}\n---\n\nbody text\n")
    }

    // ---- the roster ----------------------------------------------------

    /// The TypeScript source of the authority this module derives its roster
    /// from. Read rather than called, which is the only thing a Rust test can do
    /// with a TS function and is enough to compare the two rosters.
    const SELECTORS_TS: &str = include_str!("../../../../editor/src/host/notes/selectors.ts");

    /// The frontmatter fields `isLiveNote` reads, parsed out of its body.
    ///
    /// Panics rather than returning an empty set when the function cannot be
    /// found: an empty set compares equal to an empty set, and the version of
    /// this test that shipped was two tautologies for exactly that reason.
    fn is_live_note_fields() -> BTreeSet<String> {
        let start = SELECTORS_TS.find("export function isLiveNote(").expect(
            "isLiveNote not found in editor/src/host/notes/selectors.ts. If it moved or was \
                 renamed, this test has to follow it rather than be deleted: it is the only thing \
                 holding the agent's removal roster to the authority the module doc names.",
        );
        let body = &SELECTORS_TS[start..];
        let end = body
            .find("\n}")
            .expect("isLiveNote has no closing brace at column 0");
        let body = &body[..end];

        let mut fields = BTreeSet::new();
        for (i, _) in body.match_indices("record.") {
            let rest = &body[i + "record.".len()..];
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                fields.insert(name);
            }
        }
        fields
    }

    /// **The roster really is derived, and this is what says so.**
    ///
    /// The module doc above claims a field joining `isLiveNote` fails here
    /// rather than silently becoming the sixth thing an approve-all can do, and
    /// `decisions/ai/0515` repeats that as the reason the roster is derived
    /// instead of hand-picked. The version that shipped did not check it: it
    /// asserted `markers("").len() == MARKER_LINES.len()` and then
    /// `MARKER_LINES.len() == 5`, and BOTH sides are fixed at five by their own
    /// types (`[bool; 5]` and `[(&str, &str); 5]`), so both assertions were
    /// true by construction. Meanwhile the TypeScript twin compares the Rust
    /// roster to `HIDING_MARKERS`, so the two rosters were held to each other
    /// and neither to the authority. A roster compared against a second copy of
    /// itself, which root `AGENTS.md` names as a recurring failure here
    /// (myne-md/myne#531 review round seven).
    ///
    /// Compared BOTH directions: a field added to `isLiveNote` and not here
    /// fails, and a marker here that `isLiveNote` stopped reading fails too. The
    /// second is the direction that would otherwise leave this module refusing
    /// edits on a field that no longer takes a note out of the working set.
    ///
    /// The cross-language pair stays where it was
    /// (`tests/lib/agentBulkApproval.test.ts::the marker roster`, which holds
    /// `hide.rs` to `HIDING_MARKERS`). With this holding `selectors.ts` to
    /// `hide.rs`, all three agree transitively and each test compares a real
    /// pair rather than a copy.
    #[test]
    fn the_roster_matches_is_live_note() {
        let authority = is_live_note_fields();
        assert!(
            authority.len() >= 5,
            "parsed only {} field(s) out of isLiveNote: the parse has stopped \
             describing the function, and an under-read set would make every \
             comparison below vacuous. Parsed: {authority:?}",
            authority.len()
        );

        let roster: BTreeSet<String> = MARKER_LINES
            .iter()
            .map(|(_, name)| (*name).to_string())
            .collect();
        assert_eq!(
            roster, authority,
            "the agent's removal roster and the fields isLiveNote reads have \
             diverged. Add the value-strict reader, the `markers()` entry and the \
             MARKER_LINES line in the same change as the selector, or take them \
             out together."
        );

        // The local half, still worth its line: a marker in `markers()` with no
        // test line would go unexercised by every test below.
        assert_eq!(
            markers("").len(),
            MARKER_LINES.len(),
            "every marker owes this file a test line"
        );

        // And the NAME roster a write verb reads, against the same authority. It is
        // a third copy, so it is compared rather than trusted: a field added to
        // `isLiveNote` must arrive here or a write verb could set a marker.
        let named: BTreeSet<String> = WORKING_SET_FIELDS
            .iter()
            .map(|f| (*f).to_string())
            .collect();
        assert_eq!(
            named, authority,
            "WORKING_SET_FIELDS and the fields isLiveNote reads have diverged"
        );
    }

    // ---- detection, every field ----------------------------------------

    /// A note carrying any marker is out, and one carrying none is in. The second
    /// half matters: answering "not live" for an ordinary note would make every
    /// unindexed note read as missing, the fallback's bug wearing the opposite mask.
    #[test]
    fn a_whole_body_is_live_exactly_when_it_carries_no_marker() {
        assert!(
            body_is_live(&note("title: T")),
            "a note with no marker is in the working set"
        );
        assert!(
            body_is_live("no frontmatter at all, just prose"),
            "a note with no frontmatter carries no marker"
        );
        for (line, name) in MARKER_LINES {
            assert!(
                !body_is_live(&note(&format!("title: T\n{line}"))),
                "a note carrying {name:?} is out of the working set"
            );
        }
    }

    /// The helpers are value-strict, so "this field exists" is not "this note is
    /// gone" — the distinction [`edit_hides_note`]'s tests pin for the edit direction.
    #[test]
    fn a_non_canonical_value_does_not_make_a_body_not_live() {
        for (line, name) in [
            ("trashed: true", "trashed"),
            ("template: \"true\"", "template"),
            ("archived: later", "archived"),
        ] {
            assert!(
                body_is_live(&note(&format!("title: T\n{line}"))),
                "{name:?} with a value the app does not treat as a marker must stay live"
            );
        }
    }

    #[test]
    fn an_edit_that_adds_any_marker_is_recognised() {
        for (line, name) in MARKER_LINES {
            let before = note("title: T");
            let after = note(&format!("title: T\n{line}"));
            assert!(
                edit_hides_note(&before, &after),
                "adding {name:?} takes the note out of the working set"
            );
        }
    }

    /// The case the review found: an already-trashed note being tombstoned, and
    /// every other pairing of one marker on top of another.
    ///
    /// The reason the predicate is per field rather than a difference of
    /// `isLiveNote`: under that shape `before` is already not live, so every
    /// one of these would report false and ride along inside an approve-all.
    #[test]
    fn a_marker_added_on_top_of_another_is_still_recognised() {
        for (already, already_name) in MARKER_LINES {
            for (line, name) in MARKER_LINES {
                if already == line {
                    continue;
                }
                let before = note(&format!("title: T\n{already}"));
                let after = note(&format!("title: T\n{already}\n{line}"));
                assert!(
                    edit_hides_note(&before, &after),
                    "adding {name:?} to a note that is already {already_name:?} \
                     is still a removal"
                );
            }
        }
    }

    // ---- the directions that must NOT fire ------------------------------

    #[test]
    fn an_ordinary_edit_is_not_a_removal() {
        assert!(!edit_hides_note(&note("title: T"), &note("title: T2")));
    }

    #[test]
    fn a_body_only_edit_is_not_a_removal() {
        let before = note("title: T");
        let after = format!("{}\nmore text\n", note("title: T"));
        assert!(!edit_hides_note(&before, &after));
    }

    #[test]
    fn removing_a_marker_is_not_treated_as_a_removal() {
        for (line, name) in MARKER_LINES {
            let before = note(&format!("title: T\n{line}"));
            let after = note("title: T");
            assert!(
                !edit_hides_note(&before, &after),
                "restoring from {name:?} is not destroying"
            );
        }
    }

    #[test]
    fn a_note_that_already_carries_a_marker_and_keeps_it_is_not_a_new_removal() {
        for (line, name) in MARKER_LINES {
            let before = note(&format!("title: T\n{line}"));
            let after = note(&format!("title: T2\n{line}"));
            assert!(
                !edit_hides_note(&before, &after),
                "{name:?} was already there"
            );
        }
    }

    // ---- value-strictness, the direction a fix is most likely to break ---

    /// The pre-existing behaviour, pinned across the whole roster. A user's own
    /// `trashed: true` or `template: "true"` is not a marker, and a fix aimed at
    /// widening the roster is exactly what would loosen this.
    #[test]
    fn a_users_own_non_canonical_value_is_still_not_a_marker() {
        let timestamp_fields = ["trashed", "deleted", "archived"];
        for field in timestamp_fields {
            for v in ["true", "yes", "soon", "\"\"", "2026-13-45T99:99:99Z"] {
                let before = note("title: T");
                let after = note(&format!("title: T\n{field}: {v}"));
                assert!(
                    !edit_hides_note(&before, &after),
                    "{field}: value-strict must reject {v:?}"
                );
            }
        }
        for field in ["template", "conflict"] {
            for v in ["\"true\"", "1", "True", "yes"] {
                let before = note("title: T");
                let after = note(&format!("title: T\n{field}: {v}"));
                assert!(
                    !edit_hides_note(&before, &after),
                    "{field}: only the literal unquoted `true` marks, not {v:?}"
                );
            }
        }
    }

    // ---- shapes that must not panic -------------------------------------

    #[test]
    fn a_note_with_no_frontmatter_at_all_is_handled_rather_than_panicking() {
        assert!(!edit_hides_note("just text", "just more text"));
        assert!(edit_hides_note(
            "just text",
            &note(&format!("trashed: {TS}"))
        ));
    }
}
