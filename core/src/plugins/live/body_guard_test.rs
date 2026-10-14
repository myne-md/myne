// SPDX-License-Identifier: AGPL-3.0
//! Tests for the body-span guard (`collab-editor-bridge` task 6).

use super::apply_local::{apply_local_splices, LocalSplice};
use super::body_guard::{body_start_utf16, clamp_to_body};
use crate::plugins::sync::crdt_doc::{commit_at_millis, new_note_doc};
use automerge::transaction::Transactable;
use automerge::{AutoCommit, ObjType, ReadDoc, ROOT};

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

/// §3.6: without a line-1 opener the whole document is body.
#[test]
fn no_frontmatter_means_the_whole_document_is_body() {
    assert_eq!(body_start_utf16("hello\nworld\n"), 0);
    // An opener with no matching closer is NOT frontmatter (§3.6).
    assert_eq!(body_start_utf16("---\ntitle: hi\nBody without closer"), 0);
    // The whole document is body: an insertion at the very start is kept.
    assert_eq!(
        clamp_to_body("abc", &[splice(0, 0, "X")]),
        vec![splice(0, 0, "X")]
    );
}

/// The boundary is counted in UTF-16 units, not bytes: the frontmatter carries a
/// non-ASCII title, so a byte offset would land one unit past the closer.
#[test]
fn the_boundary_is_utf16_even_when_the_frontmatter_has_non_ascii() {
    // `\u{e9}` is one UTF-16 unit, two bytes: the prefix is 21 units but 22 bytes.
    let prefix = "---\ntitle: h\u{e9}llo\n---\n";
    assert_eq!(prefix.len(), 22, "bytes");
    assert_eq!(
        prefix.chars().map(char::len_utf16).sum::<usize>(),
        21,
        "units"
    );
    let md = format!("{prefix}Body\n");
    assert_eq!(body_start_utf16(&md), 21);
    assert_eq!(&md[prefix.len()..prefix.len() + 4], "Body");
}

/// A splice wholly inside the frontmatter is dropped; one that straddles the
/// boundary is clamped to start at the body start; a body splice is untouched.
#[test]
fn frontmatter_splices_are_dropped_and_straddling_ones_clamped() {
    let md = "---\ntitle: hi\n---\nBody\n";
    let body_at = body_start_utf16(md); // 18
    assert_eq!(body_at, 18);

    // Wholly inside the frontmatter → dropped.
    assert!(clamp_to_body(md, &[splice(4, 9, "X")]).is_empty());
    // A deletion ending exactly at the body start is still frontmatter → dropped.
    assert!(clamp_to_body(md, &[splice(5, body_at, "")]).is_empty());
    // Straddles the closer → clamped to start at the body start.
    assert_eq!(
        clamp_to_body(md, &[splice(15, 20, "")]),
        vec![splice(body_at, 20, "")]
    );
    // An insertion exactly at the body start is the FIRST body character → kept.
    assert_eq!(
        clamp_to_body(md, &[splice(body_at, body_at, "Z")]),
        vec![splice(body_at, body_at, "Z")]
    );
    // A body edit survives unchanged.
    assert_eq!(
        clamp_to_body(md, &[splice(body_at, body_at + 4, "BODY")]),
        vec![splice(body_at, body_at + 4, "BODY")]
    );
}

/// End-to-end: a transaction that touches BOTH the frontmatter and the body is
/// clamped, applied, and the frontmatter stays byte-for-byte intact (each managed
/// line present exactly once, the frontmatter edit absent). A `contains(...)`-only
/// assertion would pass on a duplicated document, so the counts are exact.
#[test]
fn a_clamped_mixed_edit_leaves_the_frontmatter_once_and_untouched() {
    let md = "---\ntitle: héllo\ndeleted: 2026-01-01T00:00:00Z\n---\nBody\n";
    let body_at = body_start_utf16(md); // 52
    let raw = [splice(5, 10, "X"), splice(body_at, body_at + 4, "BODY")];
    let clamped = clamp_to_body(md, &raw);
    assert_eq!(clamped, vec![splice(body_at, body_at + 4, "BODY")]);

    let mut d = doc_with(md);
    apply_local_splices(&mut d, 0, &clamped).expect("apply");
    let out = body(&mut d);
    assert_eq!(out.matches("title: héllo").count(), 1, "{out:?}");
    assert_eq!(
        out.matches("deleted: 2026-01-01T00:00:00Z").count(),
        1,
        "{out:?}"
    );
    assert_eq!(out.matches("BODY").count(), 1, "{out:?}");
    assert!(
        !out.contains('X'),
        "the frontmatter edit must not land: {out:?}"
    );
}

/// An unknown frontmatter key is preserved: the guard clamps around the
/// frontmatter rather than parsing it into fields, so nothing it does not know
/// about is rewritten or dropped.
#[test]
fn an_unknown_frontmatter_key_survives_a_body_edit() {
    let md = "---\ntitle: hi\ncustom-key: keep-me\n---\nBody\n";
    let body_at = body_start_utf16(md);
    let mut d = doc_with(md);
    apply_local_splices(&mut d, 0, &[splice(body_at, body_at + 4, "BODY")]).expect("apply");
    let out = body(&mut d);
    assert_eq!(out.matches("custom-key: keep-me").count(), 1, "{out:?}");
    assert_eq!(out.matches("BODY").count(), 1, "{out:?}");
}
