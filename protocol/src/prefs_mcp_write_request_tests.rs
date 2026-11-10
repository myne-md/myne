// SPDX-License-Identifier: AGPL-3.0
//! The external MCP write queue as a `vault.prefs` field
//! (external-mcp-connection task 13; `decisions/ai/0752`).
//!
//! Four properties, each an acceptance criterion rather than a convenience:
//! a blob that has never queued a request re-encodes byte for byte (the
//! omission rule is real, not a doc comment), a queued request round-trips
//! through the canonical encoder unchanged, the ORDER rule collapses a retry
//! loop into one row per `(connection, folder, verb)` with the newest stamp
//! kept, and the parser refuses what it cannot represent instead of guessing.
//!
//! The last one is the load-bearing one. This field carries a folder the
//! person will be asked to GRANT, so a parser that skipped an unknown member
//! would hand the review card half a request, and the half it invented is the
//! half the person approves.
use super::*;
use alloc::vec;

fn request(
    connection: &str,
    folder: &str,
    verb: &str,
    summary: &str,
    requested_at: u64,
) -> McpWriteRequest {
    McpWriteRequest {
        connection: alloc::string::String::from(connection),
        folder: alloc::string::String::from(folder),
        requested_at,
        summary: alloc::string::String::from(summary),
        verb: alloc::string::String::from(verb),
        kind: McpRequestKind::Write,
    }
}

/// The canonical text of a `vault.prefs` holding exactly these requests.
fn encode_with(requests: alloc::vec::Vec<McpWriteRequest>) -> alloc::string::String {
    let prefs = PrefsView {
        mcp_write_requests: requests,
        ..PrefsView::default()
    };
    alloc::string::String::from_utf8(canonical_json_encode(&prefs)).expect("utf-8")
}

#[test]
fn a_vault_that_never_queued_a_request_is_byte_identical() {
    // The whole reason the field is omitted when empty: a vault that has never
    // had an out-of-scope write must not gain a member, a byte or a diff on the
    // next prefs write.
    let text = encode_with(vec![]);
    assert!(
        !text.contains("mcp_write_requests"),
        "an empty queue must cost no bytes at all: {text}"
    );
    let decoded = canonical_json_decode(text.as_bytes()).expect("round trip");
    assert!(decoded.mcp_write_requests.is_empty());
    assert_eq!(canonical_json_encode(&decoded), text.as_bytes().to_vec());
}

#[test]
fn a_queued_request_round_trips_through_the_canonical_encoder() {
    let text = encode_with(vec![request(
        "claude-desktop",
        "inbox/",
        "note_create",
        "Shopping list",
        1765432100,
    )]);
    assert!(
            text.contains(
                r#""mcp_write_requests":[{"connection":"claude-desktop","folder":"inbox/","requested_at":1765432100,"summary":"Shopping list","verb":"note_create"}]"#
            ),
            "canonical member order (connection < folder < requested_at < summary < verb): {text}"
        );
    let decoded = canonical_json_decode(text.as_bytes()).expect("round trip");
    assert_eq!(
        decoded.mcp_write_requests,
        vec![request(
            "claude-desktop",
            "inbox/",
            "note_create",
            "Shopping list",
            1765432100
        )]
    );
    assert_eq!(canonical_json_encode(&decoded), text.as_bytes().to_vec());
}

#[test]
fn a_retry_loop_collapses_into_one_row_and_sorts() {
    // The failure this prevents is a client that retries: without the dedupe
    // the queue spends the prefs budget on one client's refusals and the card
    // shows the same proposal twenty times, which is how a person learns to
    // dismiss without reading.
    let text = encode_with(vec![
        request("lm-studio", "work/", "note_append", "", 1765432000),
        request("claude-desktop", "inbox/", "note_create", "first try", 1000),
        request(
            "claude-desktop",
            "inbox/",
            "note_create",
            "second try",
            2000,
        ),
        request("claude-desktop", "archive/", "note_create", "another", 1500),
    ]);
    let decoded = canonical_json_decode(text.as_bytes()).expect("round trip");
    let rows: alloc::vec::Vec<(alloc::string::String, alloc::string::String, u64)> = decoded
        .mcp_write_requests
        .iter()
        .map(|r| (r.connection.clone(), r.folder.clone(), r.requested_at))
        .collect();
    assert_eq!(
        rows,
        vec![
            (
                alloc::string::String::from("claude-desktop"),
                alloc::string::String::from("archive/"),
                1500
            ),
            (
                alloc::string::String::from("claude-desktop"),
                alloc::string::String::from("inbox/"),
                // The NEWEST of the two attempts at the same triple survives:
                // the card should show what the client wants now, not its
                // first try.
                2000
            ),
            (
                alloc::string::String::from("lm-studio"),
                alloc::string::String::from("work/"),
                1765432000
            ),
        ],
        "sorted by connection then folder, one row per (connection, folder, verb)"
    );
    // An empty summary costs no member at all.
    assert!(
        !text.contains(r#""summary":"""#),
        "no empty summary: {text}"
    );
}

#[test]
fn an_unknown_member_is_refused_rather_than_skipped() {
    // A later build adds a member; this build must say the blob is unreadable
    // rather than hand the card a request whose missing half the person then
    // approves.
    assert!(parse_mcp_write_request(
        br#"{"connection":"a","folder":"b/","requested_at":1,"details":"x","verb":"note_create"}"#
    )
    .is_none());
}

#[test]
fn a_repeated_member_is_refused() {
    assert!(parse_mcp_write_request(
            br#"{"connection":"a","connection":"b","folder":"c/","requested_at":1,"verb":"note_create"}"#
        )
        .is_none());
}

#[test]
fn a_malformed_queue_is_a_parse_failure_not_an_empty_queue() {
    // "Nothing is waiting" and "this blob is broken" must not be the same
    // answer: the second one has to reach the degrade-on-read path.
    let text = r#"{"mcp_write_requests":[{"connection":"a"}],"screen_capture_protection":true}"#;
    assert!(
        canonical_json_decode(text.as_bytes()).is_err(),
        "an incomplete request object is malformed, not empty"
    );
    // And the well-formed one beside it still decodes, so the refusal is about
    // the broken member rather than about the field existing.
    let good = encode_with(vec![request("a", "b/", "note_create", "", 1)]);
    assert!(canonical_json_decode(good.as_bytes()).is_ok());
}

/// Emit the `mcp-write-request` vector family for `myne-test-vectors`.
///
/// `cargo test -p protocol --lib emit_mcp_write_request_vectors_for_paste -- --ignored`
///
/// Same shape as the other families: `parse_ok` pins the decoded request as its
/// canonical re-encoding plus the consumed byte count, `parse_reject` pins the
/// inputs a reader MUST refuse. The queue is the one prefs field where a reader
/// that guesses goes wrong in the direction that spends consent: the canonical
/// ORDER and the de-duplication decide which row a person is shown, so it is
/// pinned as bytes rather than described.
#[test]
#[ignore]
fn emit_mcp_write_request_vectors_for_paste() {
    extern crate std;

    // The lowercase-hex encoder the rest of this module's emitters use. Local
    // because the vectors are write-only output: nothing reads these bytes back.
    fn hex_of(bytes: &[u8]) -> alloc::string::String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut out = alloc::string::String::new();
        for byte in bytes {
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
        out
    }

    let mut dump = alloc::string::String::new();
    dump.push_str("{\n");
    dump.push_str("  \"schema\": \"mcp-write-request\",\n");
    dump.push_str("  \"protocol_version\": \"v0.1\",\n");
    dump.push_str("  \"spec_section\": \"protocol.md §9.5.2 (mcp_write_requests canonical JSON inside vault.prefs)\",\n");
    dump.push_str("  \"description\": \"Pins protocol::prefs::parse_mcp_write_request, the canonical-JSON decoder for one entry of the mcp_write_requests array inside vault.prefs (external MCP write queue, myne-md/myne#923 task 13, decisions/ai/0752). A queued entry is a PROPOSAL, never a pending write: accepting one extends that connection's write grant by exactly the folder it names. parse_ok cases pin the decoded request as its canonical re-encoding (member order connection < folder < requested_at < summary < verb, summary omitted when empty) plus the exact consumed byte count; parse_reject cases pin the inputs a reader MUST refuse rather than read generously: an unknown member, a repeated member, and a request missing a required member.\",\n");
    dump.push_str("  \"cases\": [\n");

    let emit_ok = |dump: &mut alloc::string::String, slug: &str, desc: &str, input: &[u8]| {
        let (parsed, consumed) = parse_mcp_write_request(input)
            .unwrap_or_else(|| panic!("[{slug}] parse_ok input did not parse"));
        let mut one = alloc::vec::Vec::new();
        push_mcp_write_requests(&mut one, &[parsed]);
        let canonical = &one[1..one.len() - 1];
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"mcp-write-request/v0.1/");
        dump.push_str(slug);
        dump.push_str("\",\n      \"description\": \"");
        dump.push_str(desc);
        dump.push_str(
            "\",\n      \"case_kind\": \"parse_ok\",\n      \"input_bytes_utf8_hex\": \"",
        );
        dump.push_str(&hex_of(input));
        dump.push_str("\",\n      \"expected_consumed_len\": ");
        dump.push_str(&alloc::format!("{consumed}"));
        dump.push_str(",\n      \"expected_canonical_utf8_hex\": \"");
        dump.push_str(&hex_of(canonical));
        dump.push_str("\"\n    },\n");
    };

    let emit_reject = |dump: &mut alloc::string::String, slug: &str, desc: &str, input: &[u8]| {
        assert!(
            parse_mcp_write_request(input).is_none(),
            "[{slug}] parse_reject input parsed, but a reader MUST refuse it"
        );
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"mcp-write-request/v0.1/");
        dump.push_str(slug);
        dump.push_str("\",\n      \"description\": \"");
        dump.push_str(desc);
        dump.push_str(
            "\",\n      \"case_kind\": \"parse_reject\",\n      \"input_bytes_utf8_hex\": \"",
        );
        dump.push_str(&hex_of(input));
        dump.push_str("\"\n    },\n");
    };

    emit_ok(
            &mut dump,
            "create-with-summary",
            "a create into a readable-but-not-writable folder, carrying the title the client offered",
            br#"{"connection":"claude-desktop","folder":"inbox/","requested_at":1765432100,"summary":"Shopping list","verb":"note_create"}"#,
        );
    emit_ok(
            &mut dump,
            "append-without-summary",
            "an append whose client offered no summary: the member is absent, so the queue costs no bytes for a value that does not exist",
            br#"{"connection":"lm-studio","folder":"work/","requested_at":1765432000,"verb":"note_append"}"#,
        );
    emit_ok(
            &mut dump,
            "root-folder",
            "a write into the vault ROOT, which is a folder key like any other (the empty string) and the one a prefix rule must not swallow",
            br#"{"connection":"a","folder":"","requested_at":1,"verb":"note_create"}"#,
        );
    emit_ok(
            &mut dump,
            "member-order-not-enforced",
            "the decoder reads what an encoder wrote, so a differently ordered object decodes to the same canonical bytes",
            br#"{"verb":"note_set_field","summary":"due: 2026-11-01","requested_at":7,"folder":"projects/","connection":"a"}"#,
        );
    emit_reject(
            &mut dump,
            "unknown-member",
            "a member this build does not know: refusing is what stops the card approving half a request",
            br#"{"connection":"a","folder":"b/","requested_at":1,"summary":"x","verb":"note_create","width":2}"#,
        );
    emit_reject(
            &mut dump,
            "repeated-member",
            "two values for one key: a blob this build did not write, and last-wins would silently pick one",
            br#"{"connection":"a","connection":"b","folder":"c/","requested_at":1,"verb":"note_create"}"#,
        );
    emit_reject(
            &mut dump,
            "missing-connection",
            "no connection name: the row could not be matched to a grant, so there is nothing to accept",
            br#"{"folder":"c/","requested_at":1,"verb":"note_create"}"#,
        );
    emit_reject(
            &mut dump,
            "missing-verb",
            "no verb: the card could not say what was attempted, so there is nothing to describe to the person deciding",
            br#"{"connection":"a","folder":"b/","requested_at":1}"#,
        );
    emit_reject(
            &mut dump,
            "non-string-folder",
            "a folder that is not a string: a path is user text, and a number here is a different shape entirely",
            br#"{"connection":"a","folder":7,"requested_at":1,"verb":"note_create"}"#,
        );

    // Drop the trailing comma on the last case so the file is valid JSON.
    dump.pop();
    dump.pop();
    dump.push('\n');
    dump.push_str("  ]\n}\n");

    std::fs::write("/tmp/myne_mcp_write_request_cases.json", dump.as_bytes())
        .expect("write mcp-write-request cases dump");
}
