// SPDX-License-Identifier: AGPL-3.0
//! The desktop door arm, end to end: the REAL `myne-mcp` binary, a real 0600
//! Unix socket, a real encrypted vault (external-mcp-connection,
//! myne-md/myne#923).
//!
//! ## Why this file exists rather than another unit test
//!
//! Every other test of this feature drives one side. `core`'s MCP tests drive the
//! policy over a fake [`McpNoteSource`]; `mcp`'s transport tests drive the shim
//! against a fake door; `dispatch.rs`'s tests drive the wire decode against a
//! fake seam. None of them can observe the thing the feature claims, which is
//! that a real client's `tools/call` reaches a real vault and comes back with an
//! answer clamped to the stored grant. That claim spans four crates and a
//! process boundary, and it was FALSE until this row: the shim forwarded
//! `mcp_call` to a door that had no such command, so every real call answered
//! `invalid_request`.
//!
//! So the chain here is the production one end to end: the spawned `myne-mcp`
//! process writes a frame over `cli_bridge::socket`'s real accept loop and real
//! rate limiter, `dispatch::serve_connection` decodes it, and the arm calls
//! `myne_core::plugins::mcp::host_adapters::door_call` against a vault created by
//! the app's own `note_create` path and a prefs blob written by the app's own
//! grant command. The only substitution is `TestHost` for `TauriHost` (the
//! registry lookup `try_state` cannot exist without a Tauri runtime), which is
//! the same seam `cli_bridge::scope`'s own tests use.
//!
//! ## The child's app-data directory
//!
//! `Transport::new()` resolves the door from `dirs::data_dir()`, with no
//! environment override by design — a production variable that could redirect a
//! security-load-bearing socket path would be a second way to configure it. The
//! test therefore points the CHILD at a temporary home (`HOME`, and
//! `XDG_DATA_HOME` removed) and binds the door where that home resolves to. That
//! is not a production override; it is the child's own environment, which is
//! exactly what a client's config is.
//!
//! ## The binary has to exist
//!
//! `myne-mcp` is a different crate, so `CARGO_BIN_EXE_*` cannot reach it.
//! [`shim_binary`] looks beside the test executable, which is where
//! `cargo test --workspace` (the gate that matters) builds it. If it is absent
//! the test FAILS with the command to run rather than skipping: a test that
//! quietly skips when its subject is missing is a green tick over nothing.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use myne_core::host::test_host::TestHost;
use myne_core::plugins::mcp::host_adapters::door_call;
use myne_core::plugins::mcp::tools::WireCall;
use myne_core::plugins::notes::commands::note_create_with_dir;
use myne_core::plugins::prefs::commands::set_mcp_connection_grant_from_host;
use myne_core::plugins::vault_indices::state::NoteRecord;
use myne_core::plugins::vault_indices::VaultIndicesState;
use myne_core::plugins::vault_unlock::state::{
    fixture_unlocked_with_keys, test_vault_id, VaultRuntimeState,
};
use myne_core::search::SearchIndexState;
use myne_core::test_support::{block_on, seed_real_vault_meta};
use myne_core::vault_io::StdVaultIo;
use serde_json::{json, Value};

use super::activity::SharedLastAccess;
use super::dispatch::{
    DailyAppendOutcome, DailyOutcome, ListOutcome, McpCallOutcome, McpCallRequest, NewOutcome,
    NoteLister, OpenFileOutcome, SearchOutcome, ShowOutcome,
};
use super::rate_limit::SharedRateLimiter;
use super::socket::{self, ListenerHandle};

/// The connection name the shim is configured with, and the one the vault's
/// grant is written under.
const CONNECTION: &str = "claude-desktop";

/// The folder inside the grant, and the one outside it. Lower case because the
/// canonical key form is, and the grant is compared exactly.
const IN_SCOPE_FOLDER: &str = "Projects";
const OUT_OF_SCOPE_FOLDER: &str = "Private";

// ── a short directory (the kernel caps a socket path) ──────────────────────

struct ShortDir(PathBuf);

impl ShortDir {
    fn new() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering as O};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after the epoch")
            .as_nanos();
        let name = format!("mcpm{}_{}", n % 100_000_000, SEQ.fetch_add(1, O::Relaxed));
        let path = std::env::temp_dir().join(&name);
        // `SUN_LEN` is ~104 bytes on macOS and the test's temp dir plus
        // `Library/Application Support/md.myne.desktop/cli.sock` crosses it, so
        // the fallback is `/tmp` — the same reason `socket.rs`'s `ShortDir` has
        // one.
        let path = if path.as_os_str().len() > 24 {
            PathBuf::from(format!("/tmp/{name}"))
        } else {
            path
        };
        std::fs::create_dir_all(&path).expect("create short temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ShortDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Where `dirs::data_dir()` resolves for a process whose `HOME` is `home`.
///
/// Mirrors the `dirs` crate's own two arms rather than calling it, because the
/// value this process would compute is its OWN home and the child is the one
/// that has to find the socket.
fn data_dir_for_home(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else {
        home.join(".local").join("share")
    }
}

// ── the fixture: a real vault, a real grant, a real index ──────────────────

/// The production arm's exact pipeline over a `TestHost`, so the door the child
/// talks to is the shipped one rather than a re-implementation.
struct FixtureDoor {
    host: Arc<TestHost>,
    state: Arc<VaultRuntimeState>,
    indices: Arc<VaultIndicesState>,
    search: Arc<SearchIndexState>,
    hooks: myne_core::hooks::Hooks,
}

impl NoteLister for FixtureDoor {
    fn mcp_call(&self, request: McpCallRequest) -> McpCallOutcome {
        block_on(door_call(
            &*self.host,
            &self.state,
            &self.indices,
            &self.search,
            &self.hooks,
            &StdVaultIo,
            WireCall {
                connection: &request.connection,
                tool: &request.tool,
                arguments: &request.arguments,
            },
        ))
    }

    // This fixture drives the MCP surface only; the CLI commands have their own
    // suites. `Io` rather than a panic, because a panic on a connection thread
    // would surface as a dropped socket and read like a door failure.
    fn list_notes(&self) -> ListOutcome {
        ListOutcome::Io
    }
    fn show_note(&self, _id: &str) -> ShowOutcome {
        ShowOutcome::Io
    }
    fn search_notes(&self, _query: &str) -> SearchOutcome {
        SearchOutcome::Io
    }
    fn create_note(&self, _body: &str, _folder: Option<&str>) -> NewOutcome {
        NewOutcome::Io
    }
    fn period(&self, _period: &str) -> DailyOutcome {
        DailyOutcome::Io
    }
    fn period_append(&self, _period: &str, _line: &str) -> DailyAppendOutcome {
        DailyAppendOutcome::Io
    }
    fn open_plain_file(&self, _path: &str) -> OpenFileOutcome {
        OpenFileOutcome::Io
    }
}

struct Fixture {
    home: ShortDir,
    /// `<home>/Library/Application Support/md.myne.desktop` (macOS) or the XDG
    /// equivalent: where the child will look for `cli.sock`.
    app_data: PathBuf,
    host: Arc<TestHost>,
    state: Arc<VaultRuntimeState>,
    indices: Arc<VaultIndicesState>,
    search: Arc<SearchIndexState>,
    /// In scope: `Projects`. Written through the app's own create path.
    in_scope: String,
    out_of_scope: String,
    limiter: Arc<SharedRateLimiter>,
    listener: Option<ListenerHandle>,
}

impl Fixture {
    fn new(granted: &[&str]) -> Self {
        let home = ShortDir::new();
        let app_data = data_dir_for_home(home.path()).join("md.myne.desktop");
        std::fs::create_dir_all(&app_data).expect("create app data dir");
        let host = Arc::new(TestHost::with_dirs(
            app_data.clone(),
            home.path().join("config"),
        ));
        let state = Arc::new(VaultRuntimeState::default());
        let io = StdVaultIo;
        let hooks: myne_core::hooks::Hooks = Arc::new(myne_core::hooks::NoopHooks);

        let vault_root = myne_core::paths::vault_root_for_id_from_base(&app_data, test_vault_id());
        std::fs::create_dir_all(&vault_root).expect("create vault root");
        seed_real_vault_meta(&vault_root, 0x31);

        let (in_scope, out_of_scope) = block_on(async {
            state
                .set_unlocked(test_vault_id(), fixture_unlocked_with_keys(0x71, 0x72, 4))
                .await;
            let notes_dir = myne_core::paths::notes_dir_under(&vault_root).expect("notes dir");
            let in_scope = note_create_with_dir(
                notes_dir.clone(),
                &state,
                format!("---\nfolder: {IN_SCOPE_FOLDER}/\n---\nThe quarterly alpha report."),
                &io,
                &*host,
            )
            .await
            .expect("create the in-scope note");
            let out_of_scope = note_create_with_dir(
                notes_dir,
                &state,
                format!("---\nfolder: {OUT_OF_SCOPE_FOLDER}/\n---\nThe secret alpha plan."),
                &io,
                &*host,
            )
            .await
            .expect("create the out-of-scope note");

            // The grant, written by the command the approval screen calls.
            let folders: Vec<String> = granted.iter().map(|f| format!("{f}/")).collect();
            let accepted = set_mcp_connection_grant_from_host(
                &*host,
                &state,
                &hooks,
                CONNECTION.to_string(),
                folders,
                &io,
            )
            .await
            .expect("write the grant");
            assert!(accepted, "the grant must fit in the prefs blob");
            (in_scope, out_of_scope)
        });

        // The sidebar's index and the desktop search index, populated the way
        // their real producers do: one record per note and one body document
        // each. The gate is that these are the SAME structures the app answers
        // `myne search` from — there is no second index here.
        let indices = Arc::new(VaultIndicesState::default());
        let search = Arc::new(SearchIndexState::default());
        indices.apply(
            &in_scope,
            NoteRecord {
                title: Some("Quarterly alpha".into()),
                folder: Some(format!("{IN_SCOPE_FOLDER}/")),
                ..Default::default()
            },
        );
        indices.apply(
            &out_of_scope,
            NoteRecord {
                title: Some("Secret plan".into()),
                folder: Some(format!("{OUT_OF_SCOPE_FOLDER}/")),
                ..Default::default()
            },
        );
        search.upsert(
            &in_scope,
            "Quarterly alpha",
            &format!("---\nfolder: {IN_SCOPE_FOLDER}/\n---\nThe quarterly alpha report."),
        );
        search.upsert(
            &out_of_scope,
            "Secret plan",
            &format!("---\nfolder: {OUT_OF_SCOPE_FOLDER}/\n---\nThe secret alpha plan."),
        );

        Self {
            home,
            app_data,
            host,
            state,
            indices,
            search,
            in_scope,
            out_of_scope,
            limiter: Arc::new(SharedRateLimiter::new(u32::MAX, Duration::from_secs(60))),
            listener: None,
        }
    }

    fn open_door(&mut self) {
        let door = Arc::new(FixtureDoor {
            host: Arc::clone(&self.host),
            state: Arc::clone(&self.state),
            indices: Arc::clone(&self.indices),
            search: Arc::clone(&self.search),
            hooks: std::sync::Arc::new(myne_core::hooks::NoopHooks),
        });
        self.listener = Some(
            socket::spawn(
                &self.app_data,
                door,
                Arc::clone(&self.limiter),
                SharedLastAccess::default(),
            )
            .expect("bind the command socket"),
        );
    }

    /// Reopen the door over a tighter limiter. Used to prove a refusal costs a
    /// token, which needs a budget small enough to observe.
    fn open_door_with(&mut self, limiter: Arc<SharedRateLimiter>) {
        if let Some(handle) = self.listener.take() {
            socket::teardown(Some(handle));
        }
        self.limiter = limiter;
        self.open_door();
    }

    fn close_door(&mut self) {
        socket::teardown(self.listener.take());
    }

    /// The stored grant's `last_used_at`, read through the production read path.
    ///
    /// `None` means the connection has no grant at all; `Some(None)` means it has
    /// one and has never been used. The distinction is what makes the assertion
    /// below able to fail for the right reason.
    fn stamped_last_used(&self) -> Option<Option<u64>> {
        let root = myne_core::paths::vault_root_for_id_from_base(&self.app_data, test_vault_id());
        let prefs = block_on(myne_core::plugins::prefs::commands::prefs_read_with_dir(
            &root,
            &self.state,
            &StdVaultIo,
        ))
        .expect("read the stored prefs");
        prefs
            .mcp_connections
            .get(CONNECTION)
            .map(|grant| grant.last_used_at)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.close_door();
    }
}

// ── the child process ──────────────────────────────────────────────────────

/// The `myne-mcp` binary beside this test's own executable.
///
/// `MYNE_MCP_BIN` overrides it for a caller who staged the sidecar elsewhere.
fn shim_binary() -> PathBuf {
    if let Some(explicit) = std::env::var_os("MYNE_MCP_BIN") {
        return PathBuf::from(explicit);
    }
    let exe = std::env::current_exe().expect("test executable path");
    // <target>/debug/deps/<test>-<hash> -> <target>/debug/myne-mcp
    let Some(debug_dir) = exe.parent().and_then(Path::parent) else {
        panic!("the test executable is not under a Cargo target dir: {exe:?}");
    };
    let candidate = debug_dir.join("myne-mcp");
    assert!(
        candidate.is_file(),
        "the end-to-end test needs the shim binary at {candidate:?}. Build it first: \
         `cargo build -p myne-mcp`. (This test refuses to skip: a green tick over an absent \
         client is not evidence.)"
    );
    candidate
}

/// One live stdio session with a real `myne-mcp` process.
struct Session {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    /// Kills the child if the test hangs, so a stuck read fails the suite
    /// instead of blocking it forever.
    deadline: Deadline,
}

impl Session {
    fn spawn(home: &Path, connection: Option<&str>) -> Self {
        let mut command = Command::new(shim_binary());
        command
            .env("HOME", home)
            // The child must resolve `dirs::data_dir()` under its own HOME, so an
            // inherited XDG_DATA_HOME (which wins on Linux) is cleared.
            .env_remove("XDG_DATA_HOME")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        match connection {
            Some(name) => {
                command.env("MYNE_MCP_CONNECTION", name);
            }
            // A hand-configured client that names nothing: the shim falls back to
            // its own `unnamed-client`, and nobody approved that.
            None => {
                command.env_remove("MYNE_MCP_CONNECTION");
            }
        }
        let mut child = command.spawn().expect("spawn myne-mcp");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        let deadline = Deadline::arm(child.id(), Duration::from_secs(120));
        Self {
            child,
            stdin,
            stdout,
            deadline,
        }
    }

    /// One `tools/call`, one reply. Returns the whole JSON-RPC response.
    fn call(&mut self, id: u64, tool: &str, arguments: Value) -> Value {
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": tool, "arguments": arguments },
        });
        self.write_frame(&frame)
    }

    fn write_frame(&mut self, frame: &Value) -> Value {
        let mut line = serde_json::to_string(frame).expect("frame encodes");
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .expect("write the frame");
        self.stdin.flush().expect("flush the frame");
        let mut reply = String::new();
        self.stdout
            .read_line(&mut reply)
            .expect("read the reply line");
        assert!(
            !reply.trim().is_empty(),
            "the shim answered nothing; it may have exited, see its stderr"
        );
        serde_json::from_str(&reply).expect("the reply is JSON")
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.deadline.disarm();
    }
}

/// Kill the child if the session outlives its deadline. The shape (a
/// `recv_timeout` on a channel the owner disarms by dropping the sender) is
/// `cli_bridge::socket`'s own watchdog, for the same reason: a test that blocks
/// on a stuck peer must fail rather than hang the suite.
struct Deadline {
    disarm: Option<std::sync::mpsc::Sender<()>>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl Deadline {
    fn arm(pid: u32, after: Duration) -> Self {
        let (disarm, rx) = std::sync::mpsc::channel::<()>();
        let join = std::thread::Builder::new()
            .name("myne-mcp-door-test-deadline".to_string())
            .spawn(move || {
                if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) = rx.recv_timeout(after) {
                    // SIGKILL, so a wedged read fails loudly at once. Nothing in
                    // the child owns state a signal could corrupt: it holds no
                    // key and writes no file.
                    unsafe {
                        libc::kill(pid as libc::pid_t, libc::SIGKILL);
                    }
                }
            })
            .expect("spawn the deadline thread");
        Self {
            disarm: Some(disarm),
            join: Some(join),
        }
    }

    fn disarm(&mut self) {
        self.disarm.take();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

// ── a direct client, for what the shim would refuse before forwarding ──────

/// Write one length-prefixed frame and read one reply, over a raw connection.
/// Used for the frames the shim itself validates (malformed arguments), because
/// those never reach the door through a real client.
fn ask_door(app_data: &Path, body: &[u8]) -> Value {
    use std::io::Read;
    let mut client = std::os::unix::net::UnixStream::connect(socket::socket_path(app_data))
        .expect("connect to the door");
    client
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("read timeout");
    let mut wire = (body.len() as u32).to_le_bytes().to_vec();
    wire.extend_from_slice(body);
    client.write_all(&wire).expect("write the frame");
    let mut prefix = [0u8; 4];
    client
        .read_exact(&mut prefix)
        .expect("read the reply prefix");
    let len = u32::from_le_bytes(prefix) as usize;
    let mut reply = vec![0u8; len];
    client.read_exact(&mut reply).expect("read the reply body");
    serde_json::from_slice(&reply).expect("the reply is JSON")
}

// ── tests ──────────────────────────────────────────────────────────────────

#[test]
fn a_real_client_searches_inside_the_grant_and_never_outside_it() {
    let mut fixture = Fixture::new(&[IN_SCOPE_FOLDER]);
    fixture.open_door();
    let mut session = Session::spawn(fixture.home.path(), Some(CONNECTION));

    // In scope: the note comes back, with the fields the tool promises.
    let reply = session.call(1, "note_search", json!({ "query": "alpha" }));
    let result = &reply["result"];
    assert_eq!(result["isError"], false, "reply: {reply}");
    let rows = result["structuredContent"]
        .as_array()
        .expect("the search's structuredContent is a row array");
    assert_eq!(rows.len(), 1, "expected one in-scope row: {rows:?}");
    assert_eq!(rows[0]["noteId"], fixture.in_scope.as_str());
    assert_eq!(rows[0]["folder"], format!("{IN_SCOPE_FOLDER}/"));
    assert!(
        rows[0]["excerpt"]
            .as_str()
            .is_some_and(|e| e.contains("quarterly")),
        "the excerpt must come from the decrypted note: {rows:?}"
    );

    // Out of scope: the SAME term, matching a note the index really holds (the
    // in-scope query above proves the index ranks, and the note exists on disk
    // because `myne`'s own create path wrote it). An empty row set, not an
    // error and not a different shape: an excluded hit and a genuine no-match
    // must be indistinguishable, or the reply is an oracle for a folder the user
    // did not grant.
    let reply = session.call(2, "note_search", json!({ "query": "secret" }));
    assert_eq!(
        reply["result"]["structuredContent"],
        json!([]),
        "an out-of-scope hit must not come back: {reply}"
    );

    // Reading it directly by id is refused with a named reason rather than
    // silently empty, because the caller asked for one specific note.
    let reply = session.call(
        3,
        "note_read",
        json!({ "note_id": fixture.out_of_scope.as_str() }),
    );
    assert_eq!(reply["result"]["isError"], true, "reply: {reply}");
    assert_eq!(
        reply["result"]["structuredContent"]["reason"], "out_of_scope",
        "reply: {reply}"
    );

    // And the in-scope one reads back its whole plaintext.
    let reply = session.call(
        4,
        "note_read",
        json!({ "note_id": fixture.in_scope.as_str() }),
    );
    let text = reply["result"]["content"][0]["text"]
        .as_str()
        .expect("the note is the text block");
    assert!(text.contains("The quarterly alpha report."), "{text}");
}

#[test]
fn a_real_client_that_names_no_connection_is_refused_with_no_grant() {
    // No `MYNE_MCP_CONNECTION`: the shim sends `unnamed-client`, the vault holds
    // a grant for a DIFFERENT name, and the call is refused rather than treated
    // as the owner. This is the acceptance criterion that keeps a hand-configured
    // client from arriving with the user's own authority.
    let mut fixture = Fixture::new(&[IN_SCOPE_FOLDER]);
    fixture.open_door();
    let mut session = Session::spawn(fixture.home.path(), None);

    let reply = session.call(1, "note_search", json!({ "query": "alpha" }));
    assert_eq!(reply["result"]["isError"], true, "reply: {reply}");
    assert_eq!(
        reply["result"]["structuredContent"]["reason"], "no_grant",
        "reply: {reply}"
    );
    let sentence = reply["result"]["content"][0]["text"]
        .as_str()
        .expect("a refusal carries its sentence");
    assert!(
        sentence.contains("Myne"),
        "the sentence a human reads must name the product: {sentence}"
    );

    // A name that was never approved is the same answer, not a different one.
    drop(session);
    let mut session = Session::spawn(fixture.home.path(), Some("some-other-client"));
    let reply = session.call(2, "vault_state", json!({}));
    assert_eq!(
        reply["result"]["structuredContent"]["reason"], "no_grant",
        "reply: {reply}"
    );
}

#[test]
fn a_call_made_while_the_vault_is_locked_answers_vault_locked_and_an_unlock_resumes_the_session() {
    let mut fixture = Fixture::new(&[IN_SCOPE_FOLDER]);
    fixture.open_door();
    let mut session = Session::spawn(fixture.home.path(), Some(CONNECTION));

    // Unlocked first, so the locked answer below cannot be an artifact of a door
    // that never worked.
    let reply = session.call(1, "vault_state", json!({}));
    assert_eq!(reply["result"]["isError"], false, "reply: {reply}");

    // Two synthetic readings of the state's own clock, far enough apart that a
    // reset anywhere between them changes the answer. The FIRST reading claims
    // the state's activity origin and returns 0, so the gap is what the second
    // one must reproduce — an assertion built as "before == after" cannot fail
    // here, because both would be 0 whatever happened in between.
    let idle_before = fixture.state.idle_millis(1_000_000);

    // Lock the vault underneath the live session. The door's own socket would be
    // torn down by the lifecycle supervisor within a tick; here the socket stays
    // bound so the DOOR's lock arm is what answers, which is the narrower case.
    block_on(async { fixture.state.take(test_vault_id()).await });

    let reply = session.call(2, "vault_state", json!({}));
    assert_eq!(reply["result"]["isError"], true, "reply: {reply}");
    assert_eq!(
        reply["result"]["structuredContent"]["reason"], "vault_locked",
        "reply: {reply}"
    );

    // A6: the call must not have reset the auto-lock idle clock. `report_activity`
    // is the only sink that resets it, and nothing on this path calls it — the
    // CLI door's threat-model bullet states this as a guarantee, so it is
    // asserted rather than assumed. The idle time is expected to have grown by
    // EXACTLY the synthetic gap: any activity record between the two readings
    // would make it smaller, and a record at or after the second reading makes
    // it zero.
    assert_eq!(
        fixture.state.idle_millis(2_000_000),
        idle_before + 1_000_000,
        "an MCP call must never reset the auto-lock idle clock"
    );

    // Unlock, on the SAME client connection: the session survives, which is the
    // client-side half of lock survival (the shim never recon­nects).
    block_on(async {
        fixture
            .state
            .set_unlocked(test_vault_id(), fixture_unlocked_with_keys(0x71, 0x72, 4))
            .await
    });
    let reply = session.call(3, "note_search", json!({ "query": "alpha" }));
    assert_eq!(reply["result"]["isError"], false, "reply: {reply}");
    assert_eq!(
        reply["result"]["structuredContent"][0]["noteId"],
        fixture.in_scope.as_str()
    );
}

#[test]
fn a_malformed_call_is_answered_with_invalid_request() {
    // The shim refuses a non-object `arguments` itself, so these frames come
    // from a direct client: the DOOR's own malformed answer is what is under
    // test. A field the tool does not know, a missing required field and a
    // non-object arguments value are all refused as malformed rather than
    // silently accepted with the unknown field ignored (`deny_unknown_fields`).
    let mut fixture = Fixture::new(&[IN_SCOPE_FOLDER]);
    fixture.open_door();

    for body in [
        // A scope field smuggled into the arguments: there is no field for it,
        // and inventing one must not be tolerated.
        json!({
            "cmd": "mcp_call",
            "connection": CONNECTION,
            "tool": "note_search",
            "arguments": { "query": "alpha", "scope": [format!("{OUT_OF_SCOPE_FOLDER}/")] },
        }),
        // A missing required argument.
        json!({
            "cmd": "mcp_call",
            "connection": CONNECTION,
            "tool": "note_search",
            "arguments": {},
        }),
        // A verb this build does not implement (the write verbs land later).
        json!({
            "cmd": "mcp_call",
            "connection": CONNECTION,
            "tool": "note_create",
            "arguments": { "body": "x" },
        }),
    ] {
        let body = serde_json::to_vec(&body).expect("request encodes");
        let reply = ask_door(&fixture.app_data, &body);
        assert_eq!(reply["ok"], false, "accepted {body:?}");
        assert_eq!(reply["error"]["kind"], "invalid_request", "reply: {reply}");
    }

    // And a frame with no `connection` at all never reaches a grant lookup.
    let reply = ask_door(
        &fixture.app_data,
        br#"{"cmd":"mcp_call","tool":"vault_state","arguments":{}}"#,
    );
    assert_eq!(reply["error"]["kind"], "invalid_request", "reply: {reply}");
}

#[test]
fn a_refused_call_still_costs_a_rate_limiter_token() {
    // The acceptance criterion that is easiest to lose: the limiter is checked
    // BEFORE dispatch, so a call the host then refuses has already been counted.
    // A one-token budget makes that observable: if the refusal had been free, the
    // second request would be served.
    let mut fixture = Fixture::new(&[IN_SCOPE_FOLDER]);
    fixture.open_door_with(Arc::new(SharedRateLimiter::new(1, Duration::from_secs(60))));

    let refused = ask_door(
        &fixture.app_data,
        br#"{"cmd":"mcp_call","connection":"never-approved","tool":"note_search","arguments":{"query":"alpha"}}"#,
    );
    assert_eq!(refused["error"]["kind"], "no_grant", "reply: {refused}");

    let throttled = ask_door(&fixture.app_data, br#"{"cmd":"list"}"#);
    assert_eq!(
        throttled["error"]["kind"], "rate_limited",
        "a refused call must consume the token it was let through on: {throttled}"
    );
}

#[test]
fn a_full_search_round_trip_never_touches_the_auto_lock_idle_clock() {
    // The same invariant as the locked test, on the served path: a call that
    // succeeds must not look like user activity to the auto-lock timer either.
    // A background agent polling a tool would otherwise hold the vault open
    // forever, which is the A6 line the CLI door is careful not to cross.
    let mut fixture = Fixture::new(&[IN_SCOPE_FOLDER]);
    fixture.open_door();
    let idle_before = fixture.state.idle_millis(1_000_000);

    let mut session = Session::spawn(fixture.home.path(), Some(CONNECTION));
    let reply = session.call(1, "note_search", json!({ "query": "alpha" }));
    assert_eq!(reply["result"]["isError"], false, "reply: {reply}");

    // See the locked test for why the second reading is LATER rather than
    // equal: an equal reading cannot fail once the origin is claimed.
    assert_eq!(
        fixture.state.idle_millis(2_000_000),
        idle_before + 1_000_000,
        "a served MCP call must never reset the auto-lock idle clock"
    );
}

#[test]
fn a_served_call_stamps_the_connections_last_use() {
    // The Settings row's "last used" is written on the door's own call path and
    // nowhere else, so this is the only place the end-to-end claim can be made.
    // Without it the row would report "not used since it was approved" about a
    // client that is working, which is the failure the stamp exists to prevent.
    let mut fixture = Fixture::new(&[IN_SCOPE_FOLDER]);
    fixture.open_door();
    assert_eq!(
        fixture.stamped_last_used(),
        Some(None),
        "an approved connection starts with no stamp"
    );

    let mut session = Session::spawn(fixture.home.path(), Some(CONNECTION));
    let reply = session.call(1, "note_search", json!({ "query": "alpha" }));
    assert_eq!(reply["result"]["isError"], false, "reply: {reply}");

    // The reply is written after the arm returns, and the arm awaits the stamp,
    // so the value is on disk before this reads it.
    assert!(
        matches!(fixture.stamped_last_used(), Some(Some(_))),
        "a served call must stamp the connection's last use"
    );
}
