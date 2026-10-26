// SPDX-License-Identifier: AGPL-3.0
//! The stdio loop's refusals, driven through in-memory streams.
//!
//! These are the branches a subprocess test cannot reach cheaply: an oversized
//! frame (a four-mebibyte fixture), invalid UTF-8, and the rule that a
//! notification gets no reply. The process-level test in `tests/stdio_test.rs`
//! covers the same loop over real pipes, but only for the happy paths.

use std::io::Cursor;

use serde_json::Value;

use crate::serve::serve;

/// Run one session over `input` and return the decoded replies, in order.
fn run(input: &[u8], max_frame_bytes: usize) -> Vec<Value> {
    let mut reader = Cursor::new(input.to_vec());
    let mut out: Vec<u8> = Vec::new();
    serve(&mut reader, &mut out, max_frame_bytes).expect("in-memory streams do not fail");
    out.split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).expect("every reply is one JSON line"))
        .collect()
}

const PING: &[u8] = br#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;

#[test]
fn two_requests_get_two_replies_and_eof_ends_the_loop() {
    let mut input = Vec::new();
    input.extend_from_slice(PING);
    input.push(b'\n');
    input.extend_from_slice(br#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
    input.push(b'\n');

    let replies = run(&input, crate::MAX_FRAME_BYTES);

    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["id"], 1);
    assert_eq!(replies[1]["id"], 2);
    assert_eq!(replies[1]["result"]["tools"].as_array().unwrap().len(), 9);
}

#[test]
fn a_blank_line_is_not_a_frame() {
    let mut input = b"\n\n   \n".to_vec();
    input.extend_from_slice(PING);
    input.push(b'\n');

    let replies = run(&input, crate::MAX_FRAME_BYTES);

    assert_eq!(replies.len(), 1, "blank lines must not produce replies");
    assert_eq!(replies[0]["id"], 1);
}

#[test]
fn a_notification_gets_no_reply() {
    // MCP's own `notifications/initialized` arrives in this shape, and a reply
    // to it is a protocol violation every strict client rejects.
    let mut input = br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.to_vec();
    input.push(b'\n');
    input.extend_from_slice(PING);
    input.push(b'\n');

    let replies = run(&input, crate::MAX_FRAME_BYTES);

    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["id"], 1, "the only reply belongs to the ping");
}

#[test]
fn a_frame_of_exactly_the_cap_is_legal() {
    let frame = br#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    let mut input = frame.to_vec();
    input.push(b'\n');

    let replies = run(&input, frame.len());

    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["id"], 1);
    assert!(
        replies[0].get("error").is_none(),
        "a frame at the cap must be answered, not refused"
    );
}

#[test]
fn an_oversized_frame_is_refused_rather_than_buffered() {
    // The cap is a parameter so this fixture is bytes, not mebibytes. The
    // request AFTER the oversized one must never be answered: the loop has no
    // trustworthy frame boundary to resynchronise on, so it ends.
    let mut input =
        b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"pad\":\"xxxxxxxxxxxxxxxx\"}".to_vec();
    input.push(b'\n');
    input.extend_from_slice(PING);
    input.push(b'\n');

    let replies = run(&input, 16);

    assert_eq!(replies.len(), 1, "the loop must end after the refusal");
    assert_eq!(
        replies[0]["error"]["code"],
        crate::protocol::INVALID_REQUEST
    );
    assert_eq!(replies[0]["id"], Value::Null);
}

#[test]
fn invalid_utf8_is_a_parse_error_and_the_loop_continues() {
    // The line boundary is intact, so unlike an oversized frame this one can be
    // refused and the session carries on.
    let mut input = b"\xff\xfe\n".to_vec();
    input.extend_from_slice(PING);
    input.push(b'\n');

    let replies = run(&input, crate::MAX_FRAME_BYTES);

    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["error"]["code"], crate::protocol::PARSE_ERROR);
    assert_eq!(replies[1]["id"], 1, "the session must survive a bad frame");
}
