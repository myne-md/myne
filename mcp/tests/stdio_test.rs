// SPDX-License-Identifier: AGPL-3.0
//! The binary, as a client sees it: a real process, real pipes, no Myne running.
//!
//! This is the acceptance test for the slice. Every assertion here holds with
//! no app, no vault, no socket and no key, which is the property the task
//! exists to establish: a client can be configured and can discover the surface
//! before anything is able to read a note.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

const EXPECTED_TOOLS: [&str; 13] = [
    "note_search",
    "note_read",
    "vault_list",
    "vault_state",
    "note_create",
    "note_append",
    "note_set_field",
    "note_move",
    "note_edit",
    "attachment_list",
    "attachment_read",
    "calendar_read",
    "view_list",
];

struct Session {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Session {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_myne-mcp"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Nothing should ever be written there, and a piped-but-unread
            // stderr could block the child on a full buffer.
            .stderr(Stdio::null())
            .spawn()
            .expect("the sidecar binary must be runnable");
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = BufReader::new(child.stdout.take().expect("stdout is piped"));
        Self {
            child,
            stdin,
            stdout,
        }
    }

    /// Send one frame and read the one reply it must produce.
    fn request(&mut self, frame: Value) -> Value {
        self.send(frame);
        self.read()
    }

    fn send(&mut self, frame: Value) {
        let line = serde_json::to_string(&frame).expect("a frame serialises");
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|()| self.stdin.write_all(b"\n"))
            .and_then(|()| self.stdin.flush())
            .expect("the sidecar accepts a frame");
    }

    fn read(&mut self) -> Value {
        let mut line = String::new();
        let read = self
            .stdout
            .read_line(&mut line)
            .expect("reading a reply must not fail");
        assert!(
            read > 0,
            "the sidecar closed stdout instead of answering: {line:?}"
        );
        serde_json::from_str(&line)
            .unwrap_or_else(|error| panic!("reply is not one JSON line ({error}): {line:?}"))
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn initialize(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": { "name": "stdio-test", "version": "0" }
        }
    })
}

fn tool_names(reply: &Value) -> Vec<String> {
    let mut names: Vec<String> = reply["result"]["tools"]
        .as_array()
        .expect("tools/list returns an array")
        .iter()
        .map(|tool| tool["name"].as_str().expect("a name").to_string())
        .collect();
    names.sort();
    names
}

#[test]
fn tools_list_answers_from_the_compiled_schema_with_no_app_running() {
    let mut session = Session::spawn();

    // No `initialize` first: this is the stateless client's shape, and it must
    // work on its own. There is no Myne process in this test's world.
    let reply = session.request(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));

    assert_eq!(reply["jsonrpc"], "2.0");
    assert_eq!(reply["id"], 1);
    assert!(reply.get("error").is_none(), "got {reply}");

    let mut expected: Vec<String> = EXPECTED_TOOLS.map(str::to_string).to_vec();
    expected.sort();
    assert_eq!(tool_names(&reply), expected);
}

#[test]
fn the_wire_catalog_is_the_one_the_crate_compiles_in() {
    let mut session = Session::spawn();
    let reply = session.request(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));

    let mut compiled: Vec<String> = myne_mcp::tools::catalog()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect();
    compiled.sort();

    assert_eq!(
        tool_names(&reply),
        compiled,
        "the server must serve exactly the compiled list, not a subset or a copy"
    );
}

#[test]
fn an_initialize_first_frame_selects_the_stateful_revision() {
    let mut session = Session::spawn();

    let handshake = session.request(initialize(1));
    assert_eq!(handshake["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(handshake["result"]["serverInfo"]["name"], "myne-mcp");
    assert!(
        handshake["result"]["capabilities"]["tools"].is_object(),
        "a client must be able to see that the server offers tools"
    );

    // The client's `notifications/initialized` produces no reply, so the next
    // thing read is the tools list.
    session.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    let list = session.request(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
    assert_eq!(list["id"], 2);
    assert_eq!(tool_names(&list).len(), 13);

    // The revision is fixed by the FIRST frame: a second handshake does not
    // re-select it.
    let again = session.request(initialize(3));
    assert_eq!(again["result"]["protocolVersion"], "2025-11-25");
}

#[test]
fn a_non_initialize_first_frame_selects_the_stateless_revision() {
    let mut session = Session::spawn();

    // A request with no handshake at all: the current revision's shape.
    let list = session.request(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
    assert_eq!(tool_names(&list).len(), 13);

    // The session's selection is observable on a later handshake, which is the
    // difference the sniff makes: the same frame sent FIRST reports the older
    // revision (previous test), sent second it reports the current one.
    let handshake = session.request(initialize(2));
    assert_eq!(handshake["result"]["protocolVersion"], "2026-07-28");
}

#[test]
fn an_unknown_method_is_an_error_and_the_connection_survives() {
    let mut session = Session::spawn();

    // `resources/list` is a real MCP method this surface does not offer, and it
    // stays an unknown METHOD. `tools/call` is a different refusal and is
    // asserted below: it asks for arguments this frame does not carry, which is
    // the client's error rather than an unknown verb.
    let reply = session.request(json!({ "jsonrpc": "2.0", "id": 1, "method": "resources/list" }));
    assert_eq!(reply["error"]["code"], -32601, "got {reply}");

    let incomplete = session.request(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call" }));
    assert_eq!(incomplete["error"]["code"], -32602, "got {incomplete}");

    let ping = session.request(json!({ "jsonrpc": "2.0", "id": 3, "method": "ping" }));
    assert_eq!(ping["result"], json!({}), "got {ping}");
}

#[test]
fn server_discover_answers_through_the_binary() {
    let mut session = Session::spawn();

    // A strict client of the current revision discovers by this method alone,
    // with no handshake and with no Myne process running.
    let reply = session.request(json!({ "jsonrpc": "2.0", "id": 1, "method": "server/discover" }));
    assert!(reply.get("error").is_none(), "got {reply}");
    assert_eq!(reply["result"]["protocolVersion"], "2026-07-28");
    assert_eq!(reply["result"]["serverInfo"]["name"], "myne-mcp");

    let mut expected: Vec<String> = EXPECTED_TOOLS.map(str::to_string).to_vec();
    expected.sort();
    assert_eq!(tool_names(&reply), expected);

    // The discovery list and `tools/list` are the same list, not two.
    let listed = session.request(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
    assert_eq!(reply["result"]["tools"], listed["result"]["tools"]);
}

#[test]
fn a_malformed_line_is_a_parse_error_and_the_connection_survives() {
    let mut session = Session::spawn();

    session
        .stdin
        .write_all(b"this is not json\n")
        .and_then(|()| session.stdin.flush())
        .expect("the sidecar accepts bytes");
    let reply = session.read();
    assert_eq!(reply["error"]["code"], -32700);
    assert_eq!(reply["id"], Value::Null);

    let ping = session.request(json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" }));
    assert_eq!(ping["id"], 7);
}

#[test]
fn a_closed_stdin_is_a_normal_end_of_session() {
    // Not an error path: a client that closes the pipe is done, and a non-zero
    // exit would read to a supervisor as a crash.
    let mut child = Command::new(env!("CARGO_BIN_EXE_myne-mcp"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("the sidecar binary must be runnable");

    let status = child.wait().expect("the child must exit on EOF");
    assert!(
        status.success(),
        "EOF is a normal end of session, not a failure: {status}"
    );
}
