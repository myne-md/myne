// SPDX-License-Identifier: AGPL-3.0-only
//! The revision sniff and the JSON-RPC envelope, as pure functions.

use serde_json::{json, Value};

use crate::protocol::{
    classify, error_response, revision_for_first_frame, Incoming, Revision, STATEFUL_REVISION,
    STATELESS_REVISION,
};

fn initialize() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "0" }
        }
    })
}

#[test]
fn an_initialize_first_frame_selects_the_stateful_revision() {
    assert_eq!(
        revision_for_first_frame(&initialize()),
        Revision::Stateful,
        "the handshake is what distinguishes a client that expects the older revision"
    );
}

#[test]
fn any_other_first_frame_selects_the_stateless_revision() {
    let cases = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }),
        json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        // A frame that is not even an object still has to land somewhere; the
        // envelope check refuses it a moment later, and the session revision is
        // not the thing that should decide that.
        json!("not a frame"),
    ];
    for frame in cases {
        assert_eq!(
            revision_for_first_frame(&frame),
            Revision::Stateless,
            "only a request-shaped initialize opens a stateful session: {frame}"
        );
    }
}

#[test]
fn initialize_as_a_notification_does_not_open_a_stateful_session() {
    // A notification can never open a handshake: the client would wait for a
    // response that JSON-RPC forbids the server from sending.
    let frame = json!({ "jsonrpc": "2.0", "method": "initialize" });
    assert_eq!(revision_for_first_frame(&frame), Revision::Stateless);
}

#[test]
fn the_revision_strings_are_pinned() {
    // These are a wire contract a client compares literally. A typo does not
    // fail to compile; it reads to the client as a broken server.
    assert_eq!(STATEFUL_REVISION, "2025-11-25");
    assert_eq!(STATELESS_REVISION, "2026-07-28");
    assert_eq!(Revision::Stateful.protocol_version(), STATEFUL_REVISION);
    assert_eq!(Revision::Stateless.protocol_version(), STATELESS_REVISION);
    assert_ne!(
        Revision::Stateful.protocol_version(),
        Revision::Stateless.protocol_version()
    );
}

#[test]
fn an_id_makes_it_a_request_and_its_absence_makes_it_a_notification() {
    assert_eq!(
        classify(json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/list" })),
        Ok(Incoming::Request {
            id: json!(7),
            method: "tools/list".to_string(),
            params: None,
        })
    );
    // `params` rides along untouched, because `tools/call` is the only method
    // that reads it and the envelope is not the place to validate an argument.
    assert_eq!(
        classify(json!({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "tools/call",
            "params": { "name": "note_read", "arguments": { "note_id": "a" } }
        })),
        Ok(Incoming::Request {
            id: json!(8),
            method: "tools/call".to_string(),
            params: Some(json!({ "name": "note_read", "arguments": { "note_id": "a" } })),
        })
    );
    assert_eq!(
        classify(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })),
        Ok(Incoming::Notification)
    );
}

#[test]
fn a_frame_that_is_not_json_rpc_2_0_is_an_invalid_request() {
    for frame in [
        json!({ "id": 1, "method": "tools/list" }),
        json!({ "jsonrpc": "1.0", "id": 1, "method": "tools/list" }),
        json!({ "jsonrpc": 2.0, "id": 1, "method": "tools/list" }),
        json!({ "jsonrpc": "2.0", "id": 1 }),
        json!({ "jsonrpc": "2.0", "id": 1, "method": 4 }),
        json!({ "jsonrpc": "2.0", "id": 1, "method": "" }),
        json!([{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }]),
    ] {
        let error = classify(frame.clone()).expect_err("must be refused");
        assert_eq!(error.code, crate::protocol::INVALID_REQUEST);
    }
}

#[test]
fn an_error_response_echoes_the_id_and_never_the_frame() {
    let reply = error_response(
        json!(3),
        crate::protocol::METHOD_NOT_FOUND,
        "Method not found",
    );
    assert_eq!(reply["jsonrpc"], "2.0");
    assert_eq!(reply["id"], 3);
    assert_eq!(reply["error"]["code"], crate::protocol::METHOD_NOT_FOUND);
    assert_eq!(reply["error"]["message"], "Method not found");
    assert!(reply.get("result").is_none());
}
