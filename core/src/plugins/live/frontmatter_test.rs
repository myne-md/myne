// SPDX-License-Identifier: AGPL-3.0-only
//! Tests for the durable frontmatter `updated:` rule (`collab-editor-bridge`
//! task 7).

use super::frontmatter::{fold_max_updated, max_updated, observed_updated, set_updated};

fn note(updated: &str) -> String {
    format!("---\ntitle: T\nupdated: {updated}\n---\nbody\n")
}

/// `observed_updated` reads a value-strict stamp and ignores anything that is not
/// RFC 3339 UTC, so a user's free-text `updated:` never enters the maximum.
#[test]
fn observed_updated_is_value_strict() {
    assert_eq!(
        observed_updated(&note("2026-08-11T09:00:00Z")).as_deref(),
        Some("2026-08-11T09:00:00Z")
    );
    assert_eq!(observed_updated("---\nupdated: yesterday\n---\n"), None);
    assert_eq!(observed_updated("body with no frontmatter\n"), None);
}

/// The maximum is a symmetric total order, so two devices pick the same winner
/// whichever order they fold the same two stamps in.
#[test]
fn max_updated_is_order_independent() {
    let a = "2026-08-11T09:00:00Z";
    let b = "2026-08-11T09:30:00Z";
    assert_eq!(max_updated(Some(a), Some(b)).as_deref(), Some(b));
    assert_eq!(max_updated(Some(b), Some(a)).as_deref(), Some(b));
    assert_eq!(max_updated(Some(a), None).as_deref(), Some(a));
    assert_eq!(max_updated(None, Some(b)).as_deref(), Some(b));
    assert_eq!(max_updated(None, None), None);
}

/// Folding a peer's earlier stamp and its own later one yields the later, and a
/// peer with no stamp cannot lower the running maximum.
#[test]
fn fold_max_updated_keeps_the_latest() {
    let folded = fold_max_updated(
        Some("2026-08-11T08:00:00Z"),
        [
            "2026-08-11T07:00:00Z",
            "2026-08-11T10:00:00Z",
            "2026-08-11T09:00:00Z",
        ],
    );
    assert_eq!(folded.as_deref(), Some("2026-08-11T10:00:00Z"));
}

/// Lexicographic order over fixed-width UTC stamps is chronological, which is the
/// whole basis of the rule: a same-day later time wins and a same-time tie resolves.
#[test]
fn lexicographic_order_is_chronological_for_utc_stamps() {
    assert!(
        max_updated(Some("2026-08-11T09:00:00Z"), Some("2026-08-11T09:00:01Z")).as_deref()
            == Some("2026-08-11T09:00:01Z")
    );
    assert!(
        max_updated(Some("2026-09-01T00:00:00Z"), Some("2026-08-31T23:59:59Z")).as_deref()
            == Some("2026-09-01T00:00:00Z")
    );
}

/// The durable boundary rewrites `updated:` in place, preserving every other byte.
#[test]
fn set_updated_rewrites_the_field_in_place() {
    let md =
        "---\ntitle: T\nupdated: 2026-08-11T09:00:00Z\ndeleted: 2026-01-01T00:00:00Z\n---\nbody\n";
    assert_eq!(
        set_updated(md, "2026-08-11T10:00:00Z"),
        "---\ntitle: T\nupdated: 2026-08-11T10:00:00Z\ndeleted: 2026-01-01T00:00:00Z\n---\nbody\n"
    );
}

/// A field-less frontmatter gains the key, inserted before the closing delimiter.
#[test]
fn set_updated_inserts_the_field_when_absent() {
    let md = "---\ntitle: T\n---\nbody\n";
    assert_eq!(
        set_updated(md, "2026-08-11T10:00:00Z"),
        "---\ntitle: T\nupdated: 2026-08-11T10:00:00Z\n---\nbody\n"
    );
}

/// No frontmatter → unchanged (the caller's own stamp stands).
#[test]
fn set_updated_leaves_a_note_with_no_frontmatter_unchanged() {
    let md = "just a body\n";
    assert_eq!(set_updated(md, "2026-08-11T10:00:00Z"), md);
}
