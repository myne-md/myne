// SPDX-License-Identifier: AGPL-3.0
//! Tests for the drawing-note exclusion from the live bridge (`collab-editor-bridge`
//! task 9).

use super::commands::live_session_applies;
use super::session::LiveSession;

/// A session always opens under a real actor now (myne-md/myne#958); never the zero one.
const TEST_ACTOR: [u8; 16] = [0x5Au8; 16];
use crate::host::test_host::TestHost;
use crate::plugins::live::commands::LiveSessionCommandError;
use crate::plugins::notes::crdt::encode_note_blob;

const DRAWING: &str = "---\nkind: drawing\n---\n\n```excalidraw\n{\"type\":\"excalidraw\"}\n```\n";
const TEXT: &str = "---\ntitle: T\n---\n\nbody\n";

fn open(text: &str) -> LiveSession {
    let host = TestHost::new("/base");
    let (ik, ikid, uuid) = ([0x11u8; 32], [0x22u8; 16], [0x33u8; 16]);
    let blob = encode_note_blob(text, &ik, &ikid, &uuid, &[0xAAu8; 16], &host).expect("seal");
    LiveSession::open_from_blob(&blob, "v".into(), "n".into(), uuid, TEST_ACTOR, &ik, &ikid)
        .expect("open")
}

/// A `kind: drawing` note opens no live session: the applicability guard refuses it
/// with the typed result before it is ever registered.
#[test]
fn a_drawing_note_is_not_live_applicable() {
    let session = open(DRAWING);
    assert!(session.is_drawing());
    assert!(matches!(
        live_session_applies(&session),
        Err(LiveSessionCommandError::DrawingNotApplicable)
    ));
}

/// A text note is live-applicable (the guard is scoped to drawings, not a blanket
/// refusal).
#[test]
fn a_text_note_is_live_applicable() {
    let session = open(TEXT);
    assert!(!session.is_drawing());
    assert!(live_session_applies(&session).is_ok());
}
