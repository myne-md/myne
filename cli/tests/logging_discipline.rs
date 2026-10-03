//! End-to-end logging discipline for the real `myne` binary
//! (cli-thin-client task 13; MYND-490).
//!
//! The source-level audit lives in `cli/src/logging_discipline.rs`; this is
//! the half that runs the shipped executable as a process, against a real
//! Unix socket, and reads its actual stdout and stderr — the only way to be
//! sure about what a user, a CI job or a `2>` redirect actually sees.
//!
//! **The oracle.** Every scenario feeds DENY-class sentinels in through argv,
//! stdin and the socket reply, then asserts:
//!
//! - **stderr** never contains a sentinel. It is the diagnostic channel, the
//!   one that ends up in logs and pasted transcripts (src-tauri/AGENTS.md
//!   "Secret-handling logging discipline").
//! - the **`--json` error object** never contains one either. `error.kind` and
//!   `error.message` are diagnostics, not payload.
//! - **stdout on success** DOES contain the payload. Without this the
//!   absences above would prove a dead code path rather than a closed leak.
//!
//! **How the fixture reaches a real socket without a test hook in the
//! binary.** `paths::app_data_dir` resolves through `dirs::data_dir()`, so the
//! fixture moves the directory that call resolves *to* and the production
//! resolution walks into it unchanged — no `--socket` flag, no env var the
//! binary knows about, nothing that ships. If the override ever stopped
//! working the success scenarios would fail loudly with "Myne is not running"
//! rather than passing vacuously.
//!
//! **The override is per-platform, and getting that wrong is silent.**
//! `dirs::data_dir()` reads `$XDG_DATA_HOME` on Linux but ignores it entirely
//! on macOS, where it is `$HOME/Library/Application Support`. An
//! `$XDG_DATA_HOME`-only fixture therefore left the spawned binary resolving
//! the *real* install on a developer's Mac: it never connected, the fixture's
//! listener sat in `accept()` forever, and `Drop`'s join turned the loud
//! failure this harness was designed for into a permanent hang that stalled
//! `cargo test --workspace` — and with it every `pre-push`. So the fixture
//! sets BOTH variables and computes the app dir the same way `dirs` does.

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};

// ---- sentinels ------------------------------------------------------------

const SENTINEL_NOTE_ID: &str = "sentinelnoteid-0f9a4c21-task13";
const SENTINEL_FOLDER: &str = "SentinelFolder-Finances-task13";
const SENTINEL_BODY: &str = "sentinel-body-the-quick-brown-fox-task13";
const SENTINEL_TITLE: &str = "Sentinel Title task13";
const SENTINEL_QUERY: &str = "sentinel-query-task13";
const SENTINEL_LINE: &str = "sentinel-appended-line-task13";
/// myne-md/myne#788: the `open` subcommand's one argument is a path, and a
/// path is DENY-class. It stays under a home-shaped prefix so a regression
/// that echoed it would be caught by the same assertions as the rest.
const SENTINEL_PATH: &str = "SentinelFolder-task13/sentinel-open-task13.md";

const CONTENT_SENTINELS: &[&str] = &[
    SENTINEL_NOTE_ID,
    SENTINEL_FOLDER,
    SENTINEL_BODY,
    SENTINEL_TITLE,
    SENTINEL_QUERY,
    SENTINEL_LINE,
    SENTINEL_PATH,
];

// ---- fixture --------------------------------------------------------------

/// Bundle identifier the CLI joins onto the data dir
/// (`cli/src/paths.rs::BUNDLE_IDENTIFIER`, cross-checked by
/// `scripts/check-cli-sidecar.mjs`).
const BUNDLE_IDENTIFIER: &str = "md.myne.desktop";

/// A fake desktop: a temp home the binary's own path resolution lands in,
/// optionally a `cli-status` marker, optionally a bound command socket that
/// answers exactly one request.
///
/// The directory name is kept short on purpose — a Unix socket path is capped
/// at ~104 bytes by the kernel, the same constraint the desktop-side socket
/// tests solve with their own `ShortDir` helper.
struct FakeDesktop {
    /// The fake `$HOME`. Everything the fixture creates lives under it, so
    /// cleanup is one `remove_dir_all`.
    root: PathBuf,
    app_dir: PathBuf,
    server: Option<std::thread::JoinHandle<()>>,
}

/// Rooted at `/tmp` rather than [`std::env::temp_dir`] because of the ~104-byte
/// `sun_path` cap above: macOS hands out a ~50-character per-user `$TMPDIR`,
/// and `<tmpdir>/<name>/Library/Application Support/md.myne.desktop/cli.sock`
/// overruns the cap before the fixture has bound anything.
fn unique(tag: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    PathBuf::from("/tmp").join(format!("mycli{}-{tag}{n}", std::process::id()))
}

/// The app-data dir `dirs::data_dir()` resolves to under a given `$HOME` —
/// the same per-platform split `paths::app_data_dir` inherits from `dirs`.
/// `$XDG_DATA_HOME` is set to the Linux arm's parent so both platforms are
/// pinned rather than one of them merely inheriting the developer's.
fn data_home_under(root: &std::path::Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        root.join("Library/Application Support")
    } else {
        root.join(".local/share")
    }
}

impl FakeDesktop {
    fn new(tag: &str, status: Option<&[u8]>, reply: Option<Vec<u8>>) -> Self {
        let root = unique(tag);
        let app_dir = data_home_under(&root).join(BUNDLE_IDENTIFIER);
        std::fs::create_dir_all(&app_dir).expect("create fake app-data dir");
        if let Some(marker) = status {
            std::fs::write(app_dir.join("cli-status"), marker).expect("write status marker");
        }
        let server = reply.map(|reply| {
            let listener =
                UnixListener::bind(app_dir.join("cli.sock")).expect("bind fake command socket");
            std::thread::spawn(move || {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                // Read the request frame so the peer is not left writing into
                // a closed socket, then answer with the scripted reply.
                let mut prefix = [0u8; 4];
                if stream.read_exact(&mut prefix).is_err() {
                    return;
                }
                let mut body = vec![0u8; u32::from_le_bytes(prefix) as usize];
                if stream.read_exact(&mut body).is_err() {
                    return;
                }
                let _ = stream.write_all(&(reply.len() as u32).to_le_bytes());
                let _ = stream.write_all(&reply);
                let _ = stream.flush();
            })
        });
        Self {
            root,
            app_dir,
            server,
        }
    }

    /// Run the real `myne` binary against this fixture.
    fn run(&self, args: &[&str], stdin: Option<&str>) -> Run {
        let mut child = Command::new(env!("CARGO_BIN_EXE_myne"))
            .args(args)
            .env("HOME", &self.root)
            .env("XDG_DATA_HOME", data_home_under(&self.root))
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn the myne binary");
        if let Some(text) = stdin {
            child
                .stdin
                .take()
                .expect("piped stdin")
                .write_all(text.as_bytes())
                .expect("write stdin");
        }
        let output = child.wait_with_output().expect("wait for myne");
        Run {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            app_dir: self.app_dir.display().to_string(),
        }
    }
}

impl Drop for FakeDesktop {
    fn drop(&mut self) {
        if let Some(server) = self.server.take() {
            // Wake a listener still parked in `accept()` before joining it.
            // The scenario's CLI invocation is supposed to be the connection
            // that releases it, so this only fires when the binary never
            // arrived — exactly the case the module doc wants to fail LOUDLY.
            // Without it that case is an unjoinable thread instead: the join
            // below blocks forever, `cargo test` never returns, and the
            // assertion that would have named the real problem never runs.
            //
            // The peer is dropped immediately, so the woken thread's first
            // `read_exact` sees EOF and returns. Harmless when the server is
            // already done — the listener is gone and the connect just fails.
            let _ = UnixStream::connect(self.app_dir.join("cli.sock"));
            let _ = server.join();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct Run {
    code: i32,
    stdout: String,
    stderr: String,
    /// The fixture's own path, used as the filesystem-path sentinel: no
    /// diagnostic may name the socket or the data directory it failed on.
    app_dir: String,
}

impl Run {
    /// The whole DENY-class assertion for one invocation.
    fn assert_diagnostics_are_clean(&self, scenario: &str) {
        for sentinel in CONTENT_SENTINELS {
            assert!(
                !self.stderr.contains(sentinel),
                "{scenario}: stderr carries a DENY-class value {sentinel:?}\n\
                 stderr: {:?}",
                self.stderr
            );
        }
        assert!(
            !self.stderr.contains(&self.app_dir) && !self.stderr.contains("/tmp/mycli"),
            "{scenario}: stderr names a filesystem path\nstderr: {:?}",
            self.stderr
        );
        assert!(
            !self.stderr.to_lowercase().contains("os error"),
            "{scenario}: stderr carries a raw io::Error Display\nstderr: {:?}",
            self.stderr
        );

        // The `--json` error object is a diagnostic too. Success payload
        // fields (`notes`/`body`/`results`/`id`) are deliberately not checked
        // — carrying content is what they are for.
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(self.stdout.trim()) {
            if let Some(error) = value.get("error") {
                let rendered = error.to_string();
                for sentinel in CONTENT_SENTINELS {
                    assert!(
                        !rendered.contains(sentinel),
                        "{scenario}: the --json error object carries {sentinel:?}: {rendered}"
                    );
                }
                assert!(
                    !rendered.contains("/tmp/mycli") && !rendered.to_lowercase().contains("os error"),
                    "{scenario}: the --json error object carries a path or an io::Error: {rendered}"
                );
            }
        }
    }
}

fn frame(json: &str) -> Vec<u8> {
    json.as_bytes().to_vec()
}

// ---- success paths --------------------------------------------------------

/// One success scenario: the command, what the fake desktop answers with,
/// and the payload stdout must carry.
struct SuccessCase {
    name: &'static str,
    args: &'static [&'static str],
    stdin: Option<&'static str>,
    reply: &'static str,
    expected_on_stdout: &'static str,
}

/// Every command, its scripted success reply, and the payload stdout must
/// carry — the positive half that keeps every absence assertion meaningful.
#[test]
fn every_success_path_prints_its_payload_to_stdout_and_nothing_to_stderr() {
    let cases = [
        SuccessCase {
            name: "list",
            args: &["list"],
            stdin: None,
            reply: r#"{"ok":true,"notes":["sentinelnoteid-0f9a4c21-task13"]}"#,
            expected_on_stdout: SENTINEL_NOTE_ID,
        },
        SuccessCase {
            name: "show",
            args: &["show", SENTINEL_NOTE_ID],
            stdin: None,
            reply: r#"{"ok":true,"body":"sentinel-body-the-quick-brown-fox-task13"}"#,
            expected_on_stdout: SENTINEL_BODY,
        },
        SuccessCase {
            name: "search",
            args: &["search", SENTINEL_QUERY],
            stdin: None,
            reply: r#"{"ok":true,"results":[{"id":"sentinelnoteid-0f9a4c21-task13","title":"Sentinel Title task13"}]}"#,
            expected_on_stdout: SENTINEL_TITLE,
        },
        SuccessCase {
            name: "new",
            args: &["new", "--folder", SENTINEL_FOLDER],
            stdin: Some(SENTINEL_BODY),
            reply: r#"{"ok":true,"id":"sentinelnoteid-0f9a4c21-task13"}"#,
            expected_on_stdout: SENTINEL_NOTE_ID,
        },
        SuccessCase {
            name: "daily",
            args: &["daily"],
            stdin: None,
            reply: r#"{"ok":true,"body":"sentinel-body-the-quick-brown-fox-task13"}"#,
            expected_on_stdout: SENTINEL_BODY,
        },
    ];

    for SuccessCase {
        name,
        args,
        stdin,
        reply,
        expected_on_stdout,
    } in cases
    {
        for json in [false, true] {
            let desktop = FakeDesktop::new(name, Some(b"O"), Some(frame(reply)));
            let mut argv: Vec<&str> = Vec::new();
            if json {
                argv.push("--json");
            }
            argv.extend_from_slice(args);
            let run = desktop.run(&argv, stdin);
            let scenario = format!("{name} success (json={json})");

            assert_eq!(run.code, 0, "{scenario}: stderr was {:?}", run.stderr);
            assert!(
                run.stdout.contains(expected_on_stdout),
                "{scenario}: stdout must carry the payload, got {:?}",
                run.stdout
            );
            run.assert_diagnostics_are_clean(&scenario);
        }
    }
}

/// myne-md/myne#788 (task 11): `open` succeeds silently and the PATH it was
/// given reaches neither stream. The path is the one argument this command
/// carries, and a shell script's `2>` redirect is exactly where an echoed
/// argument would end up (DENY list: a full filesystem path).
#[test]
fn open_succeeds_silently_and_never_echoes_the_path() {
    // Relative on purpose: the binary makes it absolute against its own cwd
    // before it goes on the wire, and neither form may reach a stream.
    let path = SENTINEL_PATH.to_string();
    for json in [false, true] {
        let desktop = FakeDesktop::new("open", Some(b"O"), Some(frame(r#"{"ok":true}"#)));
        let mut argv = Vec::new();
        if json {
            argv.push("--json");
        }
        argv.extend_from_slice(&["open", &path]);
        let run = desktop.run(&argv, None);
        let scenario = format!("open success (json={json})");
        assert_eq!(run.code, 0, "{scenario}: stderr was {:?}", run.stderr);
        run.assert_diagnostics_are_clean(&scenario);
        assert!(
            !run.stderr.contains(SENTINEL_PATH),
            "{scenario}: the path reached stderr"
        );
        assert!(
            !run.stdout.contains(SENTINEL_PATH),
            "{scenario}: the path reached stdout"
        );
    }
}

#[test]
fn daily_append_succeeds_silently_and_never_echoes_the_line() {
    for json in [false, true] {
        let desktop = FakeDesktop::new("dapp", Some(b"O"), Some(frame(r#"{"ok":true}"#)));
        let mut argv = Vec::new();
        if json {
            argv.push("--json");
        }
        argv.extend_from_slice(&["daily:append", SENTINEL_LINE]);
        let run = desktop.run(&argv, None);
        let scenario = format!("daily:append success (json={json})");
        assert_eq!(run.code, 0, "{scenario}: stderr was {:?}", run.stderr);
        // Note plaintext went up the wire; nothing comes back down.
        assert!(
            !run.stdout.contains(SENTINEL_LINE),
            "{scenario}: the appended line was echoed to stdout: {:?}",
            run.stdout
        );
        run.assert_diagnostics_are_clean(&scenario);
    }
}

#[test]
fn the_search_advisory_is_the_only_thing_search_writes_to_stderr() {
    // Task 7's oracle discipline, re-checked at the process boundary: the
    // advisory is fixed text on every invocation, so it cannot become a
    // count of what was filtered.
    let hit = FakeDesktop::new(
        "sadv1",
        Some(b"O"),
        Some(frame(
            r#"{"ok":true,"results":[{"id":"sentinelnoteid-0f9a4c21-task13","title":"Sentinel Title task13"}]}"#,
        )),
    );
    let with_hit = hit.run(&["search", SENTINEL_QUERY], None);
    let empty = FakeDesktop::new(
        "sadv2",
        Some(b"O"),
        Some(frame(r#"{"ok":true,"results":[]}"#)),
    );
    let without_hit = empty.run(&["search", SENTINEL_QUERY], None);

    assert_eq!(
        with_hit.stderr, without_hit.stderr,
        "the search advisory must not vary with the result set"
    );
    assert!(with_hit.stderr.contains("see Settings"));
    with_hit.assert_diagnostics_are_clean("search with a hit");
    without_hit.assert_diagnostics_are_clean("search with no hit");
}

// ---- failure classes over the socket --------------------------------------

#[test]
fn every_wire_failure_class_keeps_the_diagnostic_channel_clean() {
    // One per wire `kind` the desktop can send, plus an unrecognized kind
    // (the version-skew path `map_wire_error` forwards through).
    let replies: &[(&str, &str, i32)] = &[
        (
            "vault_locked",
            r#"{"ok":false,"error":{"kind":"vault_locked","message":"the vault locked during this request"}}"#,
            4,
        ),
        (
            "not_found",
            r#"{"ok":false,"error":{"kind":"not_found","message":"no matching note"}}"#,
            6,
        ),
        (
            "folder_excluded",
            r#"{"ok":false,"error":{"kind":"folder_excluded","message":"that folder is excluded from CLI access"}}"#,
            7,
        ),
        (
            "rate_limited",
            r#"{"ok":false,"error":{"kind":"rate_limited","message":"too many requests in a short time; wait a moment, or turn the CLI rate limit off in Settings"}}"#,
            8,
        ),
        (
            "io",
            r#"{"ok":false,"error":{"kind":"io","message":"an internal error occurred"}}"#,
            1,
        ),
        (
            "invalid_request",
            r#"{"ok":false,"error":{"kind":"invalid_request","message":"malformed request"}}"#,
            1,
        ),
        (
            "unknown_future_kind",
            r#"{"ok":false,"error":{"kind":"some_future_kind","message":"an internal error occurred"}}"#,
            1,
        ),
    ];

    // Two commands, because they carry different sentinels in argv: `show`
    // holds a note id, `new` holds a folder name AND note plaintext.
    for (kind, reply, expected_code) in replies {
        for json in [false, true] {
            for (label, args, stdin) in [
                ("show", vec!["show", SENTINEL_NOTE_ID], None),
                (
                    "new",
                    vec!["new", "--folder", SENTINEL_FOLDER],
                    Some(SENTINEL_BODY),
                ),
            ] {
                let desktop = FakeDesktop::new(kind, Some(b"O"), Some(frame(reply)));
                let mut argv = Vec::new();
                if json {
                    argv.push("--json");
                }
                argv.extend_from_slice(&args);
                let run = desktop.run(&argv, stdin);
                let scenario = format!("{label} -> {kind} (json={json})");
                assert_eq!(
                    run.code, *expected_code,
                    "{scenario}: unexpected exit code; stderr {:?}",
                    run.stderr
                );
                run.assert_diagnostics_are_clean(&scenario);
            }
        }
    }
}

#[test]
fn a_reply_that_is_not_a_reply_at_all_never_leaks_what_arrived() {
    // Garbage, an empty frame, and a peer that hangs up mid-frame. None of
    // these may be quoted back into a diagnostic.
    let garbage = format!("not json at all {SENTINEL_BODY}");
    for (label, reply) in [
        ("garbage-reply", frame(&garbage)),
        ("empty-reply", Vec::new()),
    ] {
        for json in [false, true] {
            let desktop = FakeDesktop::new(label, Some(b"O"), Some(reply.clone()));
            let mut argv = Vec::new();
            if json {
                argv.push("--json");
            }
            argv.extend_from_slice(&["show", SENTINEL_NOTE_ID]);
            let run = desktop.run(&argv, None);
            let scenario = format!("{label} (json={json})");
            assert_ne!(run.code, 0, "{scenario}: a broken reply must not succeed");
            run.assert_diagnostics_are_clean(&scenario);
        }
    }
}

// ---- refusals that never reach the socket ---------------------------------

#[test]
fn every_pre_connect_refusal_names_no_path_and_no_argument() {
    // status marker, expected exit code, label. Every case here is a refusal
    // decided BEFORE the socket is dialled, so none of them binds one.
    let cases: &[(Option<&[u8]>, i32, &str)] = &[
        (None, 3, "app not running"),
        (Some(b"D"), 5, "CLI access disabled"),
        (Some(b"L"), 4, "vault locked"),
        // Marker says open but nothing is listening: the narrow one-tick
        // race, which falls through to the generic IO failure.
        (Some(b"O"), 1, "door raced shut"),
        (Some(b"garbled"), 3, "unreadable marker"),
    ];

    for (status, expected_code, label) in cases {
        for json in [false, true] {
            let desktop = FakeDesktop::new("prec", *status, None);
            let mut argv = Vec::new();
            if json {
                argv.push("--json");
            }
            argv.extend_from_slice(&["show", SENTINEL_NOTE_ID]);
            let run = desktop.run(&argv, None);
            let scenario = format!("{label} (json={json})");
            assert_eq!(
                run.code, *expected_code,
                "{scenario}: unexpected exit code; stderr {:?}",
                run.stderr
            );
            run.assert_diagnostics_are_clean(&scenario);
        }
    }
}

#[test]
fn a_locked_vault_refusal_never_asks_for_a_password() {
    // Story 13's promise, checked as an absence in the real output rather
    // than as an intent in the code.
    let desktop = FakeDesktop::new("lockd", Some(b"L"), None);
    let run = desktop.run(&["list"], None);
    assert_eq!(run.code, 4);
    let combined = format!("{}{}", run.stdout, run.stderr).to_lowercase();
    for forbidden in ["password", "passphrase", "recovery", "unlock code"] {
        assert!(
            !combined.contains(forbidden),
            "a locked refusal must never prompt for {forbidden:?}: {combined:?}"
        );
    }
    run.assert_diagnostics_are_clean("locked refusal");
}

// ---- usage errors, with sentinels in argv ---------------------------------

#[test]
fn no_usage_error_echoes_the_argument_that_caused_it() {
    // The commonest way to reach the unknown-command arm is a dropped verb —
    // `myne <note-id>` instead of `myne show <note-id>` — which is exactly
    // how a vault-stable correlation tag would end up in a shell's `2>` file.
    let cases: &[(&str, Vec<&str>, Option<&str>)] = &[
        ("unknown command", vec![SENTINEL_NOTE_ID], None),
        (
            "unknown command with flag",
            vec!["--json", SENTINEL_FOLDER],
            None,
        ),
        (
            "list with an argument",
            vec!["list", SENTINEL_NOTE_ID],
            None,
        ),
        (
            "show with two arguments",
            vec!["show", SENTINEL_NOTE_ID, SENTINEL_FOLDER],
            None,
        ),
        ("show with no id", vec!["show"], None),
        (
            "search with two arguments",
            vec!["search", SENTINEL_QUERY, SENTINEL_BODY],
            None,
        ),
        (
            "new with a positional",
            vec!["new", SENTINEL_NOTE_ID],
            Some(SENTINEL_BODY),
        ),
        ("new with empty stdin", vec!["new"], Some("   \n")),
        ("folder flag with no value", vec!["new", "--folder"], None),
        (
            "daily:append with a blank line",
            vec!["daily:append", "   "],
            None,
        ),
        ("missing command", vec![], None),
    ];

    for (label, args, stdin) in cases {
        let desktop = FakeDesktop::new("usage", Some(b"O"), None);
        let run = desktop.run(args, *stdin);
        assert_ne!(run.code, 0, "{label}: a usage error must not exit 0");
        run.assert_diagnostics_are_clean(label);
    }
}

#[test]
fn help_is_static_text_on_stdout() {
    let desktop = FakeDesktop::new("help", None, None);
    let run = desktop.run(&["--help"], None);
    assert_eq!(run.code, 0);
    assert!(run.stdout.contains("myne [--json] <command>"));
    run.assert_diagnostics_are_clean("--help");
}

// ---- the control -----------------------------------------------------------

#[test]
fn the_fixture_really_reaches_the_binarys_own_path_resolution() {
    // If the fixture's home override stopped steering `paths::app_data_dir`
    // — on EITHER platform; the two read different variables — every success
    // scenario above would be talking to nothing, and every "stderr is clean"
    // assertion would be true for the wrong reason. A scripted reply arriving
    // intact is what rules that out.
    let desktop = FakeDesktop::new(
        "ctrl",
        Some(b"O"),
        Some(frame(
            r#"{"ok":true,"body":"sentinel-body-the-quick-brown-fox-task13"}"#,
        )),
    );
    let run = desktop.run(&["show", SENTINEL_NOTE_ID], None);
    assert_eq!(run.code, 0, "stderr: {:?}", run.stderr);
    assert_eq!(run.stdout, SENTINEL_BODY);
}
