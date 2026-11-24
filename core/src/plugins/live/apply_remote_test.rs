// SPDX-License-Identifier: AGPL-3.0-only
//! Tests for remote-change application (`collab-editor-bridge` task 5).

use super::apply_local::{apply_local_splices, LocalSplice};
use super::apply_remote::apply_remote_change;
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
    d.splice_text(&t, 0, 0, text).expect("seed");
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

/// Two disjoint edits on one remote device produce a MULTI-RANGE diff, and the
/// ranges reproduce the remote text exactly (not one span swallowing the middle).
#[test]
fn a_remote_change_yields_a_multi_range_diff_that_reproduces_the_text() {
    let mut a = doc_with("l1\nl2\nl3\nl4\nl5\n");
    let mut b = a.fork().with_actor(ActorId::from(&[0xBBu8; 16][..]));

    // A edits line 1 and line 3 in one commit (disjoint).
    apply_local_splices(&mut a, 100, &[splice(0, 2, "L1"), splice(6, 8, "L3")]).expect("edit a");
    let change = a.get_last_local_change().expect("a local change");
    let bytes = change.raw_bytes().to_vec();

    let splices = apply_remote_change(&mut b, &bytes).expect("apply remote");
    assert_eq!(
        splices,
        vec![splice(0, 1, "L"), splice(6, 7, "L")],
        "two disjoint line edits become two minimal ranges, not one"
    );
    // B's document now equals A's.
    assert_eq!(body(&mut b), "L1\nl2\nL3\nl4\nl5\n");
}

/// A single edit is one range.
#[test]
fn a_single_edit_is_one_range() {
    let mut a = doc_with("x\ny\n");
    let mut b = a.fork().with_actor(ActorId::from(&[0xBBu8; 16][..]));
    apply_local_splices(&mut a, 0, &[splice(0, 1, "X")]).expect("edit");
    let bytes = a.get_last_local_change().unwrap().raw_bytes().to_vec();
    let splices = apply_remote_change(&mut b, &bytes).expect("apply");
    assert_eq!(splices, vec![splice(0, 1, "X")]);
}

/// The self-echo guard: re-applying this device's own change is a no-op (Automerge
/// dedupes by content hash), so no splices, the editor must not re-dispatch.
#[test]
fn a_self_echo_is_a_no_op() {
    let mut a = doc_with("hello\n");
    apply_local_splices(&mut a, 0, &[splice(5, 5, " there")]).expect("edit");
    let bytes = a.get_last_local_change().unwrap().raw_bytes().to_vec();
    // Applying A's own change back to A leaves the text unchanged.
    let splices = apply_remote_change(&mut a, &bytes).expect("apply");
    assert!(
        splices.is_empty(),
        "a self-echo yields no splices: {splices:?}"
    );
    assert_eq!(body(&mut a), "hello there\n");
}

/// An insertion of a whole line is a clean insert (from == to), reproducing the
/// remote text.
#[test]
fn a_remote_line_insert_reproduces_the_text() {
    let mut a = doc_with("one\nthree\n");
    let mut b = a.fork().with_actor(ActorId::from(&[0xBBu8; 16][..]));
    // Insert "two\n" after "one\n" (byte 4).
    apply_local_splices(&mut a, 0, &[splice(4, 4, "two\n")]).expect("edit");
    let bytes = a.get_last_local_change().unwrap().raw_bytes().to_vec();
    let splices = apply_remote_change(&mut b, &bytes).expect("apply");
    assert_eq!(splices, vec![splice(4, 4, "two\n")]);
    assert_eq!(body(&mut b), "one\ntwo\nthree\n");
}

/// A malformed change is a typed error, never a panic.
#[test]
fn a_malformed_change_is_rejected() {
    let mut a = doc_with("x\n");
    assert_eq!(
        apply_remote_change(&mut a, &[0xDE, 0xAD, 0xBE, 0xEF]),
        Err(super::apply_remote::ApplyRemoteError::Malformed)
    );
}
