// SPDX-License-Identifier: AGPL-3.0-only
//! Tests for the local-edit splice application (`collab-editor-bridge` task 4).

use super::apply_local::{apply_local_splices, ApplyLocalError, LocalSplice};
use crate::plugins::sync::crdt_doc::{commit_at_millis, new_note_doc};
use automerge::transaction::Transactable;
use automerge::{ActorId, AutoCommit, ObjType, ReadDoc, ROOT};

fn doc_with(text: &str) -> AutoCommit {
    let mut d = new_note_doc(&[0xAAu8; 16]);
    let t = d
        .put_object(
            ROOT,
            crate::plugins::notes::crdt::NOTE_TEXT_KEY,
            ObjType::Text,
        )
        .expect("text obj");
    d.splice_text(&t, 0, 0, text).expect("seed text");
    commit_at_millis(&mut d, 0);
    d
}

fn body(d: &mut AutoCommit) -> String {
    let t = crate::plugins::notes::crdt::note_text_id(d).expect("text id");
    d.text(&t).expect("text")
}

fn splice(from: usize, to: usize, insert: &str) -> LocalSplice {
    LocalSplice {
        from,
        to,
        insert: insert.to_string(),
    }
}

/// The surrogate-pair fixture (the trap this task exists for): the edit point is
/// AFTER a non-BMP character, so a UTF-16 offset forwarded straight to Automerge
/// would land one scalar too far.
#[test]
fn an_edit_after_a_surrogate_pair_lands_at_the_right_scalar() {
    // "a😀b": UTF-16 [a=0..1, 😀=1..3, b=3..4]; scalar [a=0, 😀=1, b=2].
    let mut d = doc_with("a\u{1F600}b");
    // Replace "b" (UTF-16 3..4) with "c".
    apply_local_splices(&mut d, 0, &[splice(3, 4, "c")]).expect("splice");
    assert_eq!(body(&mut d), "a\u{1F600}c");

    // Insert before the emoji (UTF-16 offset 1 == scalar 1).
    let mut d2 = doc_with("a\u{1F600}b");
    apply_local_splices(&mut d2, 0, &[splice(1, 1, "X")]).expect("splice");
    assert_eq!(body(&mut d2), "aX\u{1F600}b");
}

/// A small local splice is a minimal op, not a whole-body replace: two devices
/// editing the same base converge with the base present exactly once (#428, a
/// whole-body replace would return the document twice).
#[test]
fn a_local_splice_never_duplicates_the_shared_base_on_merge() {
    let mut a = doc_with("shared\n");
    let mut b = a.fork().with_actor(ActorId::from(&[0xBBu8; 16][..]));

    // Insert just before the trailing newline (scalar 6) on each device.
    apply_local_splices(&mut a, 0, &[splice(6, 6, "-A")]).expect("edit a");
    apply_local_splices(&mut b, 0, &[splice(6, 6, "-B")]).expect("edit b");

    a.merge(&mut b).expect("merge");
    b.merge(&mut a).expect("merge");
    let ta = body(&mut a);
    let tb = body(&mut b);
    assert_eq!(ta, tb, "both devices converge");
    assert_eq!(
        ta.matches("shared").count(),
        1,
        "base present exactly once: {ta:?}"
    );
    assert!(
        ta.contains("-A") && ta.contains("-B"),
        "both edits survive: {ta:?}"
    );
}

/// Multiple ranges in one transaction apply at their correct final positions
/// (descending application keeps earlier offsets valid).
#[test]
fn multiple_ranges_apply_at_their_final_positions() {
    let mut d = doc_with("hello world");
    apply_local_splices(&mut d, 0, &[splice(0, 5, "HELLO"), splice(6, 11, "WORLD")])
        .expect("splice");
    assert_eq!(body(&mut d), "HELLO WORLD");
}

/// A range endpoint inside a surrogate pair, and an inverted range, are typed
/// errors, never a silent misplacement.
#[test]
fn a_mid_surrogate_or_inverted_range_is_rejected() {
    let mut d = doc_with("a\u{1F600}b");
    // UTF-16 offset 2 is inside the surrogate pair.
    assert_eq!(
        apply_local_splices(&mut d, 0, &[splice(2, 2, "x")]),
        Err(ApplyLocalError::NotOnCharBoundary)
    );
    // 1 -> 0 is inverted.
    assert_eq!(
        apply_local_splices(&mut d, 0, &[splice(1, 0, "x")]),
        Err(ApplyLocalError::OutOfBounds)
    );
    // Overlapping ranges.
    let mut e = doc_with("abcd");
    assert_eq!(
        apply_local_splices(&mut e, 0, &[splice(0, 2, "x"), splice(1, 3, "y")]),
        Err(ApplyLocalError::OutOfBounds)
    );
    // The failed calls changed nothing.
    assert_eq!(body(&mut d), "a\u{1F600}b");
    assert_eq!(body(&mut e), "abcd");
}

/// Deleting a non-BMP character by its UTF-16 span removes exactly one scalar.
#[test]
fn deleting_a_surrogate_pair_removes_one_scalar() {
    let mut d = doc_with("a\u{1F600}b");
    // UTF-16 1..3 is the emoji.
    apply_local_splices(&mut d, 0, &[splice(1, 3, "")]).expect("delete emoji");
    assert_eq!(body(&mut d), "ab");
}
