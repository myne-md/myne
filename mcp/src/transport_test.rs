// SPDX-License-Identifier: AGPL-3.0
//! Lock survival and the refusal taxonomy, driven through a real session.
//!
//! Every test here runs ONE stdio session (one [`crate::serve_with`] over a
//! socket pair) against a fake door in a temp app-data dir, and changes the
//! door's state underneath it. That is the shape of the requirement: a client's
//! connection must survive a lock and an unlock without reconnecting, and the
//! shim's job is to make the door's teardown invisible to it.
//!
//! Three things this module deliberately does NOT claim:
//!
//! - **It does not test the rate limiter**, which lives host-side and is shared
//!   with the CLI door. What it tests is the ordering that keeps the limiter in
//!   the path: a call is never refused from this side while the door is open, so
//!   a refusal that the host produces was counted by the host first
//!   (`a_refusal_from_the_door_reaches_the_door_first`).
//! - **It does not test scope.** Scope is resolved host-side from the stored
//!   grant; this binary has no vault and no grant.
//! - **It does not reset or read the auto-lock idle timer, and could not**: it
//!   sends no lifecycle command at all, which the recordings assert by naming
//!   every command the fake door received.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{json, Value};

use crate::errors::Refusal;
use crate::serve::MAX_FRAME_BYTES;
use crate::status;
use crate::tools::catalog;
use crate::transport::{socket_path, Transport, LENGTH_PREFIX_BYTES, MAX_FRAME_BODY};

// ── Harness ─────────────────────────────────────────────────────────────────

/// A short temp dir. Unix socket paths are kernel-capped at ~104 bytes, and a
/// macOS temp dir plus a UUID plus a basename crosses that, so the path falls
/// back to `/tmp` exactly as the CLI's own harness does.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after the epoch")
            .as_nanos();
        let name = format!("mcp{}_{}", nanos % 100_000_000, tag);
        let dir = std::env::temp_dir().join(&name);
        let dir = if dir.as_os_str().len() > 40 {
            PathBuf::from(format!("/tmp/{name}"))
        } else {
            dir
        };
        std::fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    /// Move the door to a named state: the marker is what the shim reads.
    fn set_marker(&self, byte: &[u8]) {
        std::fs::write(status::status_path(self.path()), byte).expect("write status marker");
    }

    fn clear_marker(&self) {
        let _ = std::fs::remove_file(status::status_path(self.path()));
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// One length-prefixed frame each way, as the door's own end of the wire.
fn read_frame(stream: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut prefix = [0u8; LENGTH_PREFIX_BYTES];
    stream.read_exact(&mut prefix)?;
    let declared = u32::from_le_bytes(prefix) as usize;
    assert!(
        declared <= MAX_FRAME_BODY,
        "the shim sent an oversized frame"
    );
    let mut body = vec![0u8; declared];
    stream.read_exact(&mut body)?;
    Ok(body)
}

fn write_frame(stream: &mut impl Write, body: &[u8]) -> std::io::Result<()> {
    stream.write_all(&(body.len() as u32).to_le_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

/// A listening door that records every request and answers with one canned
/// reply. Started and stopped by the test, because "the door is open" and "the
/// door is closed" are exactly what the state changes are.
struct FakeDoor {
    socket: PathBuf,
    stop: Arc<AtomicBool>,
    seen: Arc<Mutex<Vec<Value>>>,
    join: Option<JoinHandle<()>>,
}

impl FakeDoor {
    fn start(dir: &Path, reply: Value) -> Self {
        let socket = socket_path(dir);
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).expect("bind the fake door");
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");
        let stop = Arc::new(AtomicBool::new(false));
        let seen: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let reply = Arc::new(Mutex::new(reply));
        let join = {
            let stop = Arc::clone(&stop);
            let seen = Arc::clone(&seen);
            let reply = Arc::clone(&reply);
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            // The accepted stream inherits the listener's mode on
                            // some platforms; a blocking read is what this loop
                            // wants, and the loop is already bounded by `stop`.
                            let _ = stream.set_nonblocking(false);
                            if let Ok(body) = read_frame(&mut stream) {
                                if let Ok(request) = serde_json::from_slice::<Value>(&body) {
                                    seen.lock().expect("record).lock()").push(request);
                                }
                                let reply = reply.lock().expect("reply lock").clone();
                                let body = serde_json::to_vec(&reply).expect("a reply serialises");
                                let _ = write_frame(&mut stream, &body);
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(2));
                        }
                        Err(_) => break,
                    }
                }
            })
        };
        Self {
            socket,
            stop,
            seen,
            join: Some(join),
        }
    }

    fn requests(&self) -> Vec<Value> {
        self.seen.lock().expect("recording lock").clone()
    }

    fn shutdown(&mut self) {
        if let Some(join) = self.join.take() {
            self.stop.store(true, Ordering::Relaxed);
            join.join().expect("the fake door thread must not panic");
            let _ = std::fs::remove_file(&self.socket);
        }
    }
}

impl Drop for FakeDoor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// One MCP session: the client's end of one socket pair, with the shim's stdio
/// loop running on the other end. One connection, held for the whole test.
struct Session {
    writer: UnixStream,
    reader: BufReader<UnixStream>,
    join: Option<JoinHandle<std::io::Result<()>>>,
}

impl Session {
    fn start(dir: &Path) -> Self {
        Self::start_named(dir, None)
    }

    /// A session whose calls travel under an explicit connection name, so the
    /// name that reaches the door is asserted without touching the process
    /// environment (`MYNE_MCP_CONNECTION` is read once, at `Server` construction).
    fn start_named(dir: &Path, declared: Option<&str>) -> Self {
        let (client, server) = UnixStream::pair().expect("socket pair");
        let server_reader = server.try_clone().expect("clone the server end");
        let transport = Transport::at(dir.to_path_buf());
        let declared = declared.map(str::to_string);
        let join = std::thread::spawn(move || {
            let mut reader = BufReader::new(server_reader);
            let mut writer = server;
            let mut session =
                crate::server::Server::with_transport_named(transport, declared.as_deref());
            crate::serve::serve_with_server(&mut reader, &mut writer, MAX_FRAME_BYTES, &mut session)
        });
        let reader = BufReader::new(client.try_clone().expect("clone the client end"));
        Self {
            writer: client,
            reader,
            join: Some(join),
        }
    }

    fn request(&mut self, frame: Value) -> Value {
        let line = serde_json::to_string(&frame).expect("a frame serialises");
        self.writer
            .write_all(line.as_bytes())
            .and_then(|()| self.writer.write_all(b"\n"))
            .and_then(|()| self.writer.flush())
            .expect("the shim accepts a frame");
        let mut reply = String::new();
        let read = self
            .reader
            .read_line(&mut reply)
            .expect("reading a reply must not fail");
        assert!(
            read > 0,
            "the session ended instead of answering: {reply:?}"
        );
        serde_json::from_str(&reply)
            .unwrap_or_else(|error| panic!("reply is not one JSON line ({error}): {reply:?}"))
    }

    /// Close the client's end and prove the loop ended cleanly: EOF is a normal
    /// end of session, not a crash.
    fn close(mut self) {
        drop(self.writer);
        drop(self.reader);
        if let Some(join) = self.join.take() {
            let result = join.join().expect("the serve thread must not panic");
            assert!(
                result.is_ok(),
                "EOF must end the session without an error: {result:?}"
            );
        }
    }
}

fn tools_list(id: u64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/list" })
}

fn tools_call(id: u64, name: &str, arguments: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": { "name": name, "arguments": arguments }
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

fn reason(reply: &Value) -> &str {
    reply["result"]["structuredContent"]["reason"]
        .as_str()
        .unwrap_or_else(|| panic!("no refusal reason in {reply}"))
}

fn text(reply: &Value) -> &str {
    reply["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("no text block in {reply}"))
}

fn successful(text: &str) -> Value {
    json!({
        "ok": true,
        "result": { "content": [{ "type": "text", "text": text }], "isError": false }
    })
}

// ── The three states, on one connection ─────────────────────────────────────

#[test]
fn a_session_survives_a_lock_and_an_unlock_and_names_each_closed_state() {
    let dir = TempDir::new("states");
    // Start closed: the app is running, external access is on, the vault is
    // locked. No socket exists in this state, which is the whole reason the
    // marker has to exist.
    dir.set_marker(b"L");
    let mut session = Session::start(dir.path());

    // Discovery answers in a closed state, from the compiled catalog.
    assert_eq!(tool_names(&session.request(tools_list(1))).len(), 9);

    let locked = session.request(tools_call(2, "vault_state", json!({})));
    assert_eq!(locked["result"]["isError"], true);
    assert_eq!(reason(&locked), "vault_locked");
    // The sentence is what the agent relays to a human, so it is asserted
    // literally rather than by shape.
    assert_eq!(text(&locked), Refusal::VaultLocked.sentence());

    // UNLOCK: the door opens. The client is not told and does not reconnect.
    let mut door = FakeDoor::start(dir.path(), successful("the vault is unlocked"));
    dir.set_marker(b"O");

    let served = session.request(tools_call(3, "vault_state", json!({})));
    assert_eq!(served["result"]["isError"], false, "got {served}");
    assert_eq!(text(&served), "the vault is unlocked");
    let after_unlock = door.requests();
    assert_eq!(after_unlock.len(), 1, "the call must reach the door once");
    assert_eq!(after_unlock[0]["cmd"], "mcp_call");
    assert_eq!(after_unlock[0]["tool"], "vault_state");
    assert_eq!(after_unlock[0]["arguments"], json!({}));

    // LOCK AGAIN, on the same connection, and the same refusal comes back.
    door.shutdown();
    dir.set_marker(b"L");
    let locked_again = session.request(tools_call(4, "vault_state", json!({})));
    assert_eq!(reason(&locked_again), "vault_locked");

    // ...and it unlocks again. Two transitions on one connection is the
    // property: a client that had to reconnect would have dropped its session
    // at the first lock.
    let mut door = FakeDoor::start(dir.path(), successful("still here"));
    dir.set_marker(b"O");
    let reopened = session.request(tools_call(5, "vault_state", json!({})));
    assert_eq!(text(&reopened), "still here");

    // DISABLED is a distinct state with its own reason, not "locked" again.
    door.shutdown();
    dir.set_marker(b"D");
    let disabled = session.request(tools_call(6, "vault_state", json!({})));
    assert_eq!(reason(&disabled), "door_disabled");
    assert_eq!(text(&disabled), Refusal::DoorDisabled.sentence());
    assert_ne!(reason(&disabled), reason(&locked));
    assert_eq!(tool_names(&session.request(tools_list(7))).len(), 9);

    // ABSENT MARKER is the third state: the app is not running at all.
    dir.clear_marker();
    let absent = session.request(tools_call(8, "vault_state", json!({})));
    assert_eq!(reason(&absent), "app_not_running");
    assert_eq!(text(&absent), Refusal::AppNotRunning.sentence());
    assert_eq!(tool_names(&session.request(tools_list(9))).len(), 9);

    // The session is still a session after all of it.
    let ping = session.request(json!({ "jsonrpc": "2.0", "id": 10, "method": "ping" }));
    assert_eq!(ping["result"], json!({}));

    session.close();
}

#[test]
fn a_closed_door_never_gets_a_dial_and_an_open_one_never_gets_a_shim_side_refusal() {
    let dir = TempDir::new("dialling");
    dir.set_marker(b"L");
    let mut session = Session::start(dir.path());

    // Two calls while locked. Neither reaches a door, because there is no door
    // to reach: the refusal is the shim's, and it is honest about that.
    for id in 1..=2 {
        assert_eq!(
            reason(&session.request(tools_call(id, "vault_state", json!({})))),
            "vault_locked"
        );
    }

    // Open the door, and every call goes through it: the shim cannot know what
    // the host would refuse, and a call it answered here would be a call the
    // host's rate limiter never counted.
    let door = FakeDoor::start(dir.path(), successful("ok"));
    dir.set_marker(b"O");
    for id in 3..=5 {
        let reply = session.request(tools_call(id, "vault_state", json!({})));
        assert_eq!(reply["result"]["isError"], false, "got {reply}");
    }
    let requests = door.requests();
    assert_eq!(requests.len(), 3, "every open-door call reaches the door");
    for request in &requests {
        assert_eq!(
            request["cmd"], "mcp_call",
            "the shim sends tool calls and nothing else: {request}"
        );
    }

    session.close();
}

#[test]
fn the_connection_name_travels_with_the_call_and_the_handshake_is_the_fallback() {
    // Two sessions, because the precedence is the point: a client configured by
    // hand is named by its own handshake, and a client whose config carries the
    // approved name cannot rename itself by declaring a different one.
    for (tag, pinned, handshake_name, expected) in [
        ("name-handshake", None, "Claude Desktop", "Claude Desktop"),
        (
            "name-pinned",
            Some("claude-desktop"),
            "Claude Desktop",
            "claude-desktop",
        ),
    ] {
        let dir = TempDir::new(tag);
        let door = FakeDoor::start(dir.path(), successful("ok"));
        dir.set_marker(b"O");
        let mut session = Session::start_named(dir.path(), pinned);

        let handshake = session.request(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": handshake_name, "version": "1" }
            }
        }));
        assert_eq!(handshake["result"]["serverInfo"]["name"], "myne-mcp");

        let reply = session.request(tools_call(2, "note_search", json!({ "query": "needle" })));
        assert_eq!(reply["result"]["isError"], false, "got {reply}");

        let requests = door.requests();
        let call = requests.last().expect("the call reached the door");
        assert_eq!(call["tool"], "note_search");
        assert_eq!(call["arguments"]["query"], "needle");
        assert_eq!(
            call["connection"], expected,
            "the name the host resolves the grant by ({tag})"
        );
        session.close();
    }
}

#[test]
fn a_refusal_from_the_door_reaches_the_door_first() {
    // The rate limiter is host-side and shared with the CLI door. What this
    // asserts is the half this binary owns: a refusal the host produces is
    // relayed, not replaced, and the request that produced it arrived. A shim
    // that answered refusals locally would make the limiter a free way to probe
    // the vault's state.
    let dir = TempDir::new("rate-limited");
    let door = FakeDoor::start(
        dir.path(),
        json!({ "ok": false, "error": { "kind": "rate_limited", "message": "Too many requests." } }),
    );
    dir.set_marker(b"O");
    let mut session = Session::start(dir.path());

    let reply = session.request(tools_call(1, "note_search", json!({ "query": "x" })));
    assert_eq!(reply["result"]["isError"], true);
    assert_eq!(reason(&reply), "rate_limited");
    assert_eq!(text(&reply), "Too many requests.");
    assert_eq!(
        door.requests().len(),
        1,
        "the refused call must have been sent, or the limiter never saw it"
    );

    session.close();
}

#[test]
fn a_host_refusal_kind_that_is_not_a_wire_label_never_reaches_the_client_raw() {
    let dir = TempDir::new("hostile-kind");
    let door = FakeDoor::start(
        dir.path(),
        json!({
            "ok": false,
            "error": { "kind": "Rate Limited\n[forged]", "message": "line one\nline two" }
        }),
    );
    dir.set_marker(b"O");
    let mut session = Session::start(dir.path());

    let reply = session.request(tools_call(1, "vault_state", json!({})));
    assert_eq!(reason(&reply), crate::errors::GENERIC_REASON);
    assert!(
        !text(&reply).contains('\n'),
        "a relayed control character would forge output: {:?}",
        text(&reply)
    );
    assert_eq!(
        door.requests().len(),
        1,
        "the hostile text arrives on a reply, so the call itself was served"
    );

    session.close();
}

// ── Discovery ───────────────────────────────────────────────────────────────

#[test]
fn server_discover_answers_from_the_same_compiled_catalog() {
    let dir = TempDir::new("discover");
    dir.set_marker(b"L");
    let mut session = Session::start(dir.path());

    let discovered =
        session.request(json!({ "jsonrpc": "2.0", "id": 1, "method": "server/discover" }));
    assert!(discovered.get("error").is_none(), "got {discovered}");
    assert_eq!(discovered["result"]["serverInfo"]["name"], "myne-mcp");
    assert_eq!(
        discovered["result"]["protocolVersion"], "2026-07-28",
        "a stateless first frame discovers the stateless revision"
    );
    assert_eq!(
        discovered["result"]["capabilities"]["tools"],
        json!({}),
        "a client must see that the server offers tools"
    );

    // The load-bearing half: discovery and `tools/list` read ONE list, so they
    // cannot disagree about the surface a client will call.
    let listed = session.request(tools_list(2));
    assert_eq!(discovered["result"]["tools"], listed["result"]["tools"]);
    assert_eq!(
        discovered["result"]["tools"],
        json!(catalog()),
        "the wire catalog is the compiled one"
    );

    // It answers with the app absent too: discovery must not depend on vault
    // state, or a client cannot even get configured.
    dir.clear_marker();
    let absent = session.request(json!({ "jsonrpc": "2.0", "id": 3, "method": "server/discover" }));
    assert_eq!(tool_names(&absent).len(), 9);

    session.close();
}

#[test]
fn server_discover_reports_the_revision_the_first_frame_selected() {
    let dir = TempDir::new("discover-revision");
    let mut session = Session::start(dir.path());

    session.request(json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": { "protocolVersion": "2025-11-25", "capabilities": {} }
    }));
    let discovered =
        session.request(json!({ "jsonrpc": "2.0", "id": 2, "method": "server/discover" }));
    assert_eq!(discovered["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(tool_names(&discovered).len(), 9);

    session.close();
}

// ── Request shape ───────────────────────────────────────────────────────────

#[test]
fn an_unknown_tool_is_refused_without_reaching_the_door() {
    // A verb this surface does not offer is refused here rather than forwarded,
    // because there is nothing host-side to ask: the exclusion classes (delete,
    // rename, whole-body replace) are absent verbs, not verbs that fail later.
    let dir = TempDir::new("unknown-tool");
    let door = FakeDoor::start(dir.path(), successful("this must never be served"));
    dir.set_marker(b"O");
    let mut session = Session::start(dir.path());

    for name in ["note_delete", "note_rename", "note_replace_body", ""] {
        let reply = session.request(tools_call(1, name, json!({})));
        assert_eq!(reply["result"]["isError"], true, "for {name:?}: {reply}");
        assert_eq!(reason(&reply), "unknown_tool", "for {name:?}: {reply}");
    }
    assert!(
        door.requests().is_empty(),
        "an unknown verb must not be forwarded"
    );

    session.close();
}

#[test]
fn a_tools_call_without_a_usable_name_or_arguments_is_a_protocol_error() {
    let dir = TempDir::new("bad-params");
    dir.set_marker(b"L");
    let mut session = Session::start(dir.path());

    for frame in [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call" }),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {} }),
        json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": 4 } }),
        json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": { "name": "vault_state", "arguments": "not an object" }
        }),
    ] {
        let reply = session.request(frame.clone());
        assert_eq!(
            reply["error"]["code"], -32602,
            "a malformed call is the client's error, not a closed door: {frame} -> {reply}"
        );
    }

    session.close();
}
