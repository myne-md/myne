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
//! `cargo nextest run --workspace` (the gate that matters) builds it. If it is absent
//! the test FAILS with the command to run rather than skipping: a test that
//! quietly skips when its subject is missing is a green tick over nothing.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use myne_core::host::test_host::TestHost;
use myne_core::plugins::mcp::host_adapters::{door_call, DoorContext};
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

/// The two folders the fixture's vault holds. The grant is a DENY list, so the
/// connection reads `Projects` by default and `Private` is the folder it leaves
/// out. Mixed case on purpose: the stored exclusion is canonicalised
/// (`canonical_input_folder`), so a test that passed the same case through both
/// sides could not tell the canonicaliser from an exact match.
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
    /// The live co-editing registry: a write verb refuses a note a session owns,
    /// so the door cannot answer a write without it.
    registry: Arc<myne_core::plugins::live::LiveSessionRegistry>,
}

impl NoteLister for FixtureDoor {
    fn mcp_call(&self, request: McpCallRequest) -> McpCallOutcome {
        block_on(door_call(
            DoorContext {
                host: &*self.host,
                state: &self.state,
                indices: &self.indices,
                search: &self.search,
                hooks: &self.hooks,
                registry: &self.registry,
                io: &StdVaultIo,
            },
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
    registry: Arc<myne_core::plugins::live::LiveSessionRegistry>,
    hooks: myne_core::hooks::Hooks,
    /// `Projects`: readable, because the grant excludes `Private` and not this
    /// one. Written through the app's own create path.
    in_scope: String,
    /// `Private`: named in the grant's exclusion list, so every tool must answer
    /// as though it does not exist.
    out_of_scope: String,
    limiter: Arc<SharedRateLimiter>,
    listener: Option<ListenerHandle>,
}

impl Fixture {
    fn new(excluded: &[&str]) -> Self {
        Self::with_write(excluded, &[])
    }

    /// The same vault, with `write` named in the grant's write list.
    ///
    /// A second constructor rather than a parameter on `new`, because twelve
    /// fixtures are about the READ gate and an empty write grant is the state every
    /// connection starts in; spelling `&[]` twelve times would obscure that.
    fn with_write(excluded: &[&str], write: &[&str]) -> Self {
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

            // The grant, written by the command the approval screen calls. The
            // argument is the set of folders the connection may NOT read, so the
            // fixture names the one folder it wants out of reach rather than the
            // one it wants in. Under the previous allow-list model the same
            // array would have meant the opposite.
            let excluded_folders: Vec<String> = excluded.iter().map(|f| format!("{f}/")).collect();
            // The write list is empty and says so on purpose: this fixture is
            // about the READ gate, and an empty write grant is the state every
            // connection starts in.
            let write_folders: Vec<String> = write.iter().map(|f| format!("{f}/")).collect();
            let accepted = set_mcp_connection_grant_from_host(
                &*host,
                &state,
                &hooks,
                CONNECTION.to_string(),
                excluded_folders,
                write_folders,
                Vec::new(),
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
            registry: Arc::new(myne_core::plugins::live::LiveSessionRegistry::new()),
            hooks: std::sync::Arc::new(myne_core::hooks::NoopHooks),
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
            hooks: std::sync::Arc::clone(&self.hooks),
            registry: Arc::clone(&self.registry),
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
    let mut fixture = Fixture::new(&[OUT_OF_SCOPE_FOLDER]);
    fixture.open_door();
    let mut session = Session::spawn(fixture.home.path(), Some(CONNECTION));

    // In scope: the note comes back, with the fields the tool promises.
    let reply = session.call(1, "note_search", json!({ "query": "alpha" }));
    let result = &reply["result"];
    assert_eq!(result["isError"], false, "reply: {reply}");
    let rows = result["structuredContent"]["items"]
        .as_array()
        .expect("the search's structuredContent.items is the row array");
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
        json!({ "items": [] }),
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
    let mut fixture = Fixture::new(&[OUT_OF_SCOPE_FOLDER]);
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
    let mut fixture = Fixture::new(&[OUT_OF_SCOPE_FOLDER]);
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
        reply["result"]["structuredContent"]["items"][0]["noteId"],
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
    let mut fixture = Fixture::new(&[OUT_OF_SCOPE_FOLDER]);
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
        // A verb this build does not implement (`note_set_field` and the two
        // anchored verbs land as their own tasks).
        json!({
            "cmd": "mcp_call",
            "connection": CONNECTION,
            "tool": "note_set_field",
            "arguments": { "note_id": "x", "field": "f", "value": "v" },
        }),
        // A WRITE verb this build does implement, missing its required fields:
        // malformed, not version skew. The two are different answers, and a test
        // that only carried the unimplemented verb could not tell them apart.
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
    let mut fixture = Fixture::new(&[OUT_OF_SCOPE_FOLDER]);
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
    let mut fixture = Fixture::new(&[OUT_OF_SCOPE_FOLDER]);
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
    let mut fixture = Fixture::new(&[OUT_OF_SCOPE_FOLDER]);
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

// ── the write half: a real create, a real append, a real restore point ─────

/// The `.myn` bytes of one note, as they are on disk right now.
///
/// Reading the blob rather than the plaintext is deliberate: a snapshot is a copy
/// of THIS, so "the restore returned the prior bytes" is a claim about bytes and
/// only the file can answer it.
fn note_blob(fixture: &Fixture, note_id: &str) -> Vec<u8> {
    let root = myne_core::paths::vault_root_for_id_from_base(&fixture.app_data, test_vault_id());
    std::fs::read(root.join("notes").join(format!("{note_id}.myn"))).expect("read the note blob")
}

/// Every note id in the vault, so a test can assert that NOTHING was written
/// rather than only that one id is unchanged.
fn note_ids(fixture: &Fixture) -> Vec<String> {
    let root = myne_core::paths::vault_root_for_id_from_base(&fixture.app_data, test_vault_id());
    let mut ids: Vec<String> = std::fs::read_dir(root.join("notes"))
        .expect("list the notes dir")
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            let name = path.file_name()?.to_str()?.to_string();
            name.strip_suffix(".myn").map(str::to_string)
        })
        .collect();
    ids.sort();
    ids
}

/// The queued proposals in the stored prefs, as the review card reads them.
fn queued_writes(fixture: &Fixture) -> Vec<protocol::McpWriteRequest> {
    let root = myne_core::paths::vault_root_for_id_from_base(&fixture.app_data, test_vault_id());
    block_on(myne_core::plugins::prefs::commands::prefs_read_with_dir(
        &root,
        &fixture.state,
        &StdVaultIo,
    ))
    .expect("read the stored prefs")
    .mcp_write_requests
}

#[test]
fn a_real_client_creates_a_note_inside_the_write_grant_and_reads_it_back() {
    // The whole point of the write grant: a folder named for writing accepts a
    // note, and the caller gets the id back so it can read what it wrote.
    let mut fixture = Fixture::with_write(&[OUT_OF_SCOPE_FOLDER], &[IN_SCOPE_FOLDER]);
    fixture.open_door();
    let mut session = Session::spawn(fixture.home.path(), Some(CONNECTION));

    let reply = session.call(
        1,
        "note_create",
        json!({
            "folder": format!("{IN_SCOPE_FOLDER}/"),
            "title": "Written by a client",
            "body": "Paragraph one.",
        }),
    );
    assert_eq!(reply["result"]["isError"], false, "reply: {reply}");
    let note_id = reply["result"]["structuredContent"]["noteId"]
        .as_str()
        .expect("a create answers with the new note's id")
        .to_string();
    assert!(
        note_ids(&fixture).contains(&note_id),
        "the note must exist on disk: {note_id}"
    );

    // The fixture's index is HAND-FED, exactly as it is for the two seeded notes
    // above: in the app the notes plugin owns `VaultIndicesState` and upserts on
    // create, and here that state is a standalone value the test owns. Sweeping it
    // would make this test pass while proving nothing about the write.
    fixture.indices.apply(
        &note_id,
        NoteRecord {
            title: Some("Written by a client".into()),
            folder: Some(format!("{IN_SCOPE_FOLDER}/")),
            ..Default::default()
        },
    );

    // Read it back through the door, which is the claim the caller cares about.
    let reply = session.call(2, "note_read", json!({ "note_id": note_id }));
    assert_eq!(reply["result"]["isError"], false, "reply: {reply}");
    let body = reply["result"]["structuredContent"]["body"]
        .as_str()
        .expect("a read answers with the body");
    assert!(body.contains("Written by a client"), "{body}");
    assert!(body.contains("Paragraph one."), "{body}");
    assert!(
        body.contains(&format!("folder: {IN_SCOPE_FOLDER}/")),
        "{body}"
    );
}

#[test]
fn a_create_outside_the_write_grant_is_queued_and_nothing_is_written() {
    // A folder the connection can READ but was not given for writing. The client
    // is told `write_queued_for_review`, the person gets a row, and the vault is
    // byte-identical afterwards.
    let mut fixture = Fixture::with_write(&[OUT_OF_SCOPE_FOLDER], &[IN_SCOPE_FOLDER]);
    fixture.open_door();
    let before = note_ids(&fixture);
    let mut session = Session::spawn(fixture.home.path(), Some(CONNECTION));

    let reply = session.call(
        1,
        "note_create",
        json!({
            "folder": "Elsewhere/",
            "title": "Not written",
            "body": "Nothing here.",
        }),
    );
    assert_eq!(
        reply["result"]["structuredContent"]["reason"], "write_queued_for_review",
        "reply: {reply}"
    );
    assert_eq!(
        note_ids(&fixture),
        before,
        "a queued proposal must not create a note"
    );
    let queued = queued_writes(&fixture);
    assert_eq!(queued.len(), 1, "{queued:?}");
    assert_eq!(queued[0].connection, CONNECTION);
    assert_eq!(queued[0].folder, "elsewhere/");
    assert_eq!(queued[0].verb, "note_create");
    // The summary is what the person reads to decide, so it carries the title.
    assert!(queued[0].summary.contains("Not written"), "{queued:?}");

    // And a SECOND attempt at the same verb in the same folder costs no extra row:
    // a retry loop is the case the card has to survive.
    let reply = session.call(
        2,
        "note_create",
        json!({ "folder": "Elsewhere/", "title": "Again", "body": "x" }),
    );
    assert_eq!(
        reply["result"]["structuredContent"]["reason"], "write_queued_for_review",
        "reply: {reply}"
    );
    assert_eq!(queued_writes(&fixture).len(), 1);
}

#[test]
fn a_search_into_a_folder_outside_the_grant_is_queued_as_a_read_request() {
    let mut fixture = Fixture::new(&[OUT_OF_SCOPE_FOLDER]);
    fixture.open_door();
    let mut session = Session::spawn(fixture.home.path(), Some(CONNECTION));

    let reply = session.call(
        1,
        "note_search",
        json!({ "query": "secret", "folder": OUT_OF_SCOPE_FOLDER }),
    );
    assert_eq!(reply["result"]["isError"], true, "reply: {reply}");
    assert_eq!(
        reply["result"]["structuredContent"]["reason"], "out_of_scope_folder",
        "reply: {reply}"
    );

    let queued = queued_writes(&fixture);
    assert_eq!(queued.len(), 1, "{queued:?}");
    assert_eq!(queued[0].connection, CONNECTION);
    assert_eq!(queued[0].folder, "private/");
    assert_eq!(queued[0].verb, "note_search");
    assert_eq!(queued[0].kind, protocol::McpRequestKind::Read);

    let reply = session.call(
        2,
        "note_create",
        json!({ "folder": OUT_OF_SCOPE_FOLDER, "title": "x", "body": "y" }),
    );
    assert_eq!(reply["result"]["isError"], true, "reply: {reply}");
    assert_eq!(
        queued_writes(&fixture).len(),
        1,
        "a refused write must not add a read card"
    );
}

#[test]
fn a_served_read_charges_the_process_budget() {
    let mut fixture = Fixture::new(&[OUT_OF_SCOPE_FOLDER]);
    fixture.open_door();
    let mut session = Session::spawn(fixture.home.path(), Some(CONNECTION));

    let reply = session.call(
        1,
        "note_read",
        json!({ "note_id": fixture.in_scope.as_str() }),
    );
    assert_eq!(reply["result"]["isError"], false, "reply: {reply}");

    let left = myne_core::plugins::mcp::budget::process_ledger()
        .lock()
        .expect("the budget ledger is not poisoned")
        .remaining(CONNECTION, 0);
    assert!(
        left < myne_core::plugins::mcp::budget::NOTES_PER_WINDOW,
        "a served note_read must charge the process ledger, got {left} of {0}",
        myne_core::plugins::mcp::budget::NOTES_PER_WINDOW
    );
}

#[test]
fn an_append_takes_a_restore_point_and_the_restore_returns_the_prior_bytes() {
    let mut fixture = Fixture::with_write(&[OUT_OF_SCOPE_FOLDER], &[IN_SCOPE_FOLDER]);
    fixture.open_door();
    // The PLAINTEXT is what a restore is compared against, not the ciphertext: the
    // restore re-encodes the snapshot under a fresh content nonce (the snapshot IS
    // the old sealed blob, and reusing its nonce would encrypt two plaintexts under
    // one key+nonce pair), so identical bytes would be a nonce reuse rather than a
    // correct restore.
    let before = block_on(myne_core::plugins::notes::commands::note_read_from_host(
        &*fixture.host,
        &fixture.state,
        fixture.in_scope.clone(),
        &StdVaultIo,
    ))
    .expect("read the note before the append");
    let blob_before = note_blob(&fixture, &fixture.in_scope);
    let mut session = Session::spawn(fixture.home.path(), Some(CONNECTION));

    let reply = session.call(
        1,
        "note_append",
        json!({
            "note_id": fixture.in_scope.as_str(),
            "markdown": "Appended by a client.",
        }),
    );
    assert_eq!(reply["result"]["isError"], false, "reply: {reply}");
    let appended = reply["result"]["structuredContent"]["appendedBytes"]
        .as_u64()
        .expect("an append reports the bytes it added");
    assert!(appended > 0, "reply: {reply}");
    assert_ne!(
        note_blob(&fixture, &fixture.in_scope),
        blob_before,
        "the append must have changed the blob"
    );

    // The restore point: exactly one snapshot for this note, and restoring it
    // returns the prior bytes byte for byte.
    let snapshots = block_on(
        myne_core::plugins::snapshots::commands::snapshot_list_from_host(
            &*fixture.host,
            &fixture.state,
            &StdVaultIo,
            fixture.in_scope.clone(),
        ),
    )
    .expect("list the note's snapshots");
    assert_eq!(
        snapshots.len(),
        1,
        "an external append must leave exactly one restore point"
    );
    block_on(
        myne_core::plugins::snapshots::commands::snapshot_restore_from_host(
            &*fixture.host,
            &fixture.state,
            &fixture.hooks,
            fixture.in_scope.clone(),
            snapshots[0].snapshot_uuid.clone(),
            &StdVaultIo,
            Some(&*fixture.registry),
        ),
    )
    .expect("restore the snapshot");
    let restored = block_on(myne_core::plugins::notes::commands::note_read_from_host(
        &*fixture.host,
        &fixture.state,
        fixture.in_scope.clone(),
        &StdVaultIo,
    ))
    .expect("read the note after the restore");
    assert_eq!(
        restored, before,
        "restore after an append must return the note to its prior text, byte for byte"
    );
}

#[test]
fn a_restore_point_that_cannot_be_taken_blocks_the_append() {
    // Injected the only way a snapshot can fail on a real disk: the `snapshots/`
    // path is a FILE, so the directory cannot be created and the capture reports
    // `Failed`. The append must then be refused and the note left alone, asserted
    // by reading the blob rather than only by trusting the reply.
    let mut fixture = Fixture::with_write(&[OUT_OF_SCOPE_FOLDER], &[IN_SCOPE_FOLDER]);
    let root = myne_core::paths::vault_root_for_id_from_base(&fixture.app_data, test_vault_id());
    std::fs::write(root.join("snapshots"), b"not a directory").expect("occupy the snapshots path");
    fixture.open_door();
    let before = note_blob(&fixture, &fixture.in_scope);
    let mut session = Session::spawn(fixture.home.path(), Some(CONNECTION));

    let reply = session.call(
        1,
        "note_append",
        json!({
            "note_id": fixture.in_scope.as_str(),
            "markdown": "This must not land.",
        }),
    );
    assert_eq!(
        reply["result"]["structuredContent"]["reason"], "restore_point_failed",
        "reply: {reply}"
    );
    assert_eq!(
        note_blob(&fixture, &fixture.in_scope),
        before,
        "a write whose restore point failed must not have changed a byte"
    );
}

#[test]
fn a_write_loop_is_throttled_by_the_same_limiter_as_a_read() {
    // Task 14's last criterion, and the one whose absence would be invisible: a
    // client that appends in a loop is a write amplifier, and the budget it spends
    // is the SAME one every other door request spends because the limiter is
    // checked before dispatch, not per verb. A one-token budget makes that
    // observable: the first write lands and the second answers `rate_limited`.
    let mut fixture = Fixture::with_write(&[OUT_OF_SCOPE_FOLDER], &[IN_SCOPE_FOLDER]);
    fixture.open_door_with(Arc::new(SharedRateLimiter::new(1, Duration::from_secs(60))));
    let note_id = fixture.in_scope.clone();

    let first = ask_door(
        &fixture.app_data,
        serde_json::to_vec(&json!({
            "cmd": "mcp_call",
            "connection": CONNECTION,
            "tool": "note_append",
            "arguments": { "note_id": note_id, "markdown": "First." },
        }))
        .expect("request encodes")
        .as_slice(),
    );
    assert_eq!(first["ok"], true, "reply: {first}");

    // The refusal comes from the door's own envelope, before the host is asked, so
    // it is the `rate_limited` kind rather than any MCP reason: the tool layer is
    // never reached, which is the whole point of counting there.
    let second = ask_door(
        &fixture.app_data,
        serde_json::to_vec(&json!({
            "cmd": "mcp_call",
            "connection": CONNECTION,
            "tool": "note_append",
            "arguments": { "note_id": fixture.in_scope.as_str(), "markdown": "Second." },
        }))
        .expect("request encodes")
        .as_slice(),
    );
    assert_eq!(second["ok"], false, "reply: {second}");
    assert_eq!(second["error"]["kind"], "rate_limited", "reply: {second}");
}
