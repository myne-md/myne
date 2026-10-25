// SPDX-License-Identifier: AGPL-3.0
//! Test-only: the desktop half of the CLI door's logging discipline
//! (cli-thin-client task 13; MYND-490).
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline". This
//! module is the machine-checked half of the claim `mod.rs` makes in prose —
//! that nothing in `cli_bridge` puts note content, a note id, a folder name
//! or a filesystem path into a log line. Note ids and folder names are
//! vault-stable correlation tags and sit in the same DENY class as salts and
//! nonces; they are fine on the *wire* (a `show` reply is a note body by
//! definition) and never fine in a `tracing` record.
//!
//! Two complementary oracles, because neither alone is enough:
//!
//! 1. **Runtime capture.** A thread-local subscriber at `TRACE` — the
//!    maximum verbosity anything in this process can ever be configured to —
//!    collects everything emitted while [`dispatch::serve_connection`] is
//!    driven across every success path and every failure class, each carrying
//!    a unique sentinel. Then: no sentinel appears in the capture. This
//!    proves the *present* behaviour but can only reach log sites a test can
//!    execute on its own thread.
//! 2. **Source audit.** The `tracing::` call sites in this directory are
//!    read out of the sources themselves and checked against a field-name and
//!    value allowlist. This reaches the sites runtime capture cannot — the
//!    accept-loop thread, the Windows arms, the bind-failure path — and,
//!    more importantly, it fails on a log site added *later*. A new field
//!    name is a deliberate stop: add it to `ALLOWED_FIELDS` only after
//!    checking the value against the DENY list.

use std::io::Cursor;
use std::sync::{Arc, Mutex};

use super::dispatch::{
    self, DailyAppendOutcome, DailyOutcome, ListOutcome, McpCallOutcome, McpCallRequest,
    NewOutcome, NoteLister, OpenFileOutcome, SearchHitWire, SearchOutcome, ShowOutcome,
};
use super::rate_limit::SharedRateLimiter;

// ---- sentinels ------------------------------------------------------------

/// A note id, in the shape the vault actually mints them, but unique enough
/// that a substring hit in a log capture cannot be a coincidence.
const SENTINEL_NOTE_ID: &str = "sentinelnoteid-0f9a4c21-task13";
/// A folder name, in the shape `cli_excluded_folders` holds them.
const SENTINEL_FOLDER: &str = "SentinelFolder-Finances-task13";
/// Note plaintext.
const SENTINEL_BODY: &str = "sentinel-body-the-quick-brown-fox-task13";
/// A note title, which travels beside an id in a `search` hit.
const SENTINEL_TITLE: &str = "Sentinel Title task13";
/// A search query — user input, and a phrase the user typed.
const SENTINEL_QUERY: &str = "sentinel-query-task13";
/// An appended line — note plaintext arriving on the write path.
const SENTINEL_LINE: &str = "sentinel-appended-line-task13";
/// A filesystem path fragment.
const SENTINEL_PATH: &str = "/tmp/sentinel-vault-path-task13/notes";

/// Every sentinel, for the blanket "none of this reaches a log" assertion.
const ALL_SENTINELS: &[&str] = &[
    SENTINEL_NOTE_ID,
    SENTINEL_FOLDER,
    SENTINEL_BODY,
    SENTINEL_TITLE,
    SENTINEL_QUERY,
    SENTINEL_LINE,
    SENTINEL_PATH,
];

fn assert_no_sentinel(captured: &str, scenario: &str) {
    for sentinel in ALL_SENTINELS {
        assert!(
            !captured.contains(sentinel),
            "{scenario}: a DENY-class value reached a log line.\n\
             sentinel: {sentinel:?}\n\
             captured: {captured:?}"
        );
    }
}

// ---- runtime capture ------------------------------------------------------

#[derive(Clone, Default)]
struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("capture buffer")
            .extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CaptureWriter {
    type Writer = CaptureWriter;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// Run `f` with a `TRACE`-level subscriber installed on THIS thread and
/// return everything it emitted.
///
/// Thread-local (`with_default`), not global, on purpose: a global default
/// can be installed once per process, so a second test would silently capture
/// nothing and pass vacuously — the worst possible failure mode for a test
/// whose whole assertion is an absence. Every log site reachable from
/// `serve_connection` fires on the calling thread, so the thread-local
/// subscriber sees all of them; the sites that fire on other threads are
/// covered by the source audit below instead of being quietly missed here.
fn capture<T>(f: impl FnOnce() -> T) -> (T, String) {
    let buffer = CaptureWriter::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(buffer.clone())
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_target(true)
        .finish();
    let value = tracing::subscriber::with_default(subscriber, f);
    let bytes = buffer.0.lock().expect("capture buffer").clone();
    (value, String::from_utf8_lossy(&bytes).into_owned())
}

/// A `NoteLister` whose every method answers with a fixed outcome, so one
/// test can drive a whole failure class across all six commands.
struct ScriptedLister {
    list: fn() -> ListOutcome,
    show: fn(&str) -> ShowOutcome,
    search: fn(&str) -> SearchOutcome,
    new_note: fn(&str, Option<&str>) -> NewOutcome,
    daily: fn(&str) -> DailyOutcome,
    daily_append: fn(&str, &str) -> DailyAppendOutcome,
    open_file: fn(&str) -> OpenFileOutcome,
}

impl NoteLister for ScriptedLister {
    fn list_notes(&self) -> ListOutcome {
        (self.list)()
    }
    fn show_note(&self, id: &str) -> ShowOutcome {
        (self.show)(id)
    }
    fn search_notes(&self, query: &str) -> SearchOutcome {
        (self.search)(query)
    }
    fn create_note(&self, body: &str, folder: Option<&str>) -> NewOutcome {
        (self.new_note)(body, folder)
    }
    fn period(&self, period: &str) -> DailyOutcome {
        (self.daily)(period)
    }
    fn period_append(&self, period: &str, line: &str) -> DailyAppendOutcome {
        (self.daily_append)(period, line)
    }
    fn open_plain_file(&self, path: &str) -> OpenFileOutcome {
        (self.open_file)(path)
    }
    /// Always `Io`: this double drives the CLI commands' failure classes, and the
    /// MCP arm's own logging is covered by the `mcp_call` frame in
    /// `every_request` reaching the same audit.
    fn mcp_call(&self, _request: McpCallRequest) -> McpCallOutcome {
        McpCallOutcome::Io
    }
}

/// Every command, each carrying a sentinel in its arguments — so a log site
/// that echoed the *request* would trip the assertion even when the reply is
/// a bare error.
fn every_request() -> Vec<Vec<u8>> {
    vec![
        br#"{"cmd":"list"}"#.to_vec(),
        serde_json::to_vec(&serde_json::json!({ "cmd": "show", "id": SENTINEL_NOTE_ID }))
            .expect("request encodes"),
        serde_json::to_vec(&serde_json::json!({ "cmd": "search", "query": SENTINEL_QUERY }))
            .expect("request encodes"),
        serde_json::to_vec(&serde_json::json!({
            "cmd": "new",
            "body": SENTINEL_BODY,
            "folder": SENTINEL_FOLDER,
        }))
        .expect("request encodes"),
        br#"{"cmd":"daily"}"#.to_vec(),
        serde_json::to_vec(&serde_json::json!({ "cmd": "daily_append", "line": SENTINEL_LINE }))
            .expect("request encodes"),
        serde_json::to_vec(&serde_json::json!({
            "cmd": "open",
            "path": format!("{SENTINEL_PATH}/sentinel-file-task13.md"),
        }))
        .expect("request encodes"),
        // The MCP surface's arm (external-mcp-connection, myne-md/myne#923),
        // carrying the same DENY-class values as its own fields: the connection
        // name is user text, the query is a typed phrase and the note id is a
        // vault-stable correlation tag.
        serde_json::to_vec(&serde_json::json!({
            "cmd": "mcp_call",
            "connection": SENTINEL_FOLDER,
            "tool": "note_read",
            "arguments": { "note_id": SENTINEL_NOTE_ID, "scope": [SENTINEL_FOLDER] },
        }))
        .expect("request encodes"),
    ]
}

fn framed(body: &[u8]) -> Vec<u8> {
    let mut v = (body.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(body);
    v
}

fn open_limiter() -> SharedRateLimiter {
    SharedRateLimiter::new(u32::MAX, std::time::Duration::from_secs(60))
}

/// Drive one request through `serve_connection` and return the reply JSON
/// (or `None` when the connection produced no frame at all, which is the
/// framing layer's answer to an unreadable request).
fn serve(request: &[u8], lister: &dyn NoteLister, limiter: &SharedRateLimiter) -> Option<Vec<u8>> {
    let mut reader = Cursor::new(request.to_vec());
    let mut writer = Vec::new();
    dispatch::serve_connection(&mut reader, &mut writer, lister, limiter, None);
    if writer.is_empty() {
        return None;
    }
    super::framing::read_frame_within(&mut Cursor::new(writer), None).ok()
}

#[test]
fn success_paths_carry_their_payload_on_the_wire_and_nothing_into_the_logs() {
    let lister = ScriptedLister {
        list: || ListOutcome::Ok(vec![SENTINEL_NOTE_ID.to_string()]),
        show: |_| ShowOutcome::Ok(SENTINEL_BODY.to_string()),
        search: |_| {
            SearchOutcome::Ok(vec![SearchHitWire {
                id: SENTINEL_NOTE_ID.to_string(),
                title: SENTINEL_TITLE.to_string(),
            }])
        },
        new_note: |_, _| NewOutcome::Ok(SENTINEL_NOTE_ID.to_string()),
        daily: |_| DailyOutcome::Ok(SENTINEL_BODY.to_string(), false),
        daily_append: |_, _| DailyAppendOutcome::Ok(false),
        open_file: |_| OpenFileOutcome::Ok,
    };
    let limiter = open_limiter();
    let (replies, captured) = capture(|| {
        every_request()
            .iter()
            .map(|r| serve(&framed(r), &lister, &limiter))
            .collect::<Vec<_>>()
    });

    // The replies really did carry the sentinels — otherwise the absence
    // below would be the absence of a code path, not of a leak.
    let wire = replies
        .iter()
        .map(|r| String::from_utf8_lossy(r.as_deref().unwrap_or(b"")).into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        wire.contains(SENTINEL_NOTE_ID) && wire.contains(SENTINEL_BODY),
        "the success replies must actually carry the payload: {wire:?}"
    );
    assert_no_sentinel(&captured, "success paths");
}

#[test]
fn every_failure_class_logs_no_denied_value() {
    // One entry per wire error kind the dispatcher can produce, driven
    // across all six commands. `invalid_request` and the framing errors get
    // their own tests below (they never reach the lister at all).
    let classes: &[(&str, ScriptedLister)] = &[
        (
            "vault_locked",
            ScriptedLister {
                list: || ListOutcome::VaultLocked,
                show: |_| ShowOutcome::VaultLocked,
                search: |_| SearchOutcome::VaultLocked,
                new_note: |_, _| NewOutcome::VaultLocked,
                daily: |_| DailyOutcome::VaultLocked,
                daily_append: |_, _| DailyAppendOutcome::VaultLocked,
                open_file: |_| OpenFileOutcome::PlainFileOff,
            },
        ),
        (
            "io",
            ScriptedLister {
                list: || ListOutcome::Io,
                show: |_| ShowOutcome::Io,
                search: |_| SearchOutcome::Io,
                new_note: |_, _| NewOutcome::Io,
                daily: |_| DailyOutcome::Io,
                daily_append: |_, _| DailyAppendOutcome::Io,
                open_file: |_| OpenFileOutcome::Io,
            },
        ),
        (
            "not_found / folder_excluded",
            ScriptedLister {
                list: || ListOutcome::Io,
                show: |_| ShowOutcome::NotFound,
                search: |_| SearchOutcome::Ok(vec![]),
                new_note: |_, _| NewOutcome::FolderExcluded,
                daily: |_| DailyOutcome::FolderExcluded,
                daily_append: |_, _| DailyAppendOutcome::FolderExcluded,
                open_file: |_| OpenFileOutcome::NotFound,
            },
        ),
    ];

    for (name, lister) in classes {
        let limiter = open_limiter();
        let (_, captured) = capture(|| {
            for request in every_request() {
                serve(&framed(&request), lister, &limiter);
            }
        });
        assert_no_sentinel(&captured, name);
    }
}

#[test]
fn a_rate_limited_request_logs_a_bounded_event_and_never_the_request() {
    let lister = ScriptedLister {
        list: || ListOutcome::Io,
        show: |_| ShowOutcome::Io,
        search: |_| SearchOutcome::Io,
        new_note: |_, _| NewOutcome::Io,
        daily: |_| DailyOutcome::Io,
        daily_append: |_, _| DailyAppendOutcome::Io,
        open_file: |_| OpenFileOutcome::Io,
    };
    // A budget of zero throttles the very first request, so the sentinel-
    // bearing frame is refused before it is even parsed.
    let limiter = SharedRateLimiter::new(0, std::time::Duration::from_secs(60));
    let (_, captured) = capture(|| {
        for request in every_request() {
            serve(&framed(&request), &lister, &limiter);
        }
    });
    assert!(
        captured.contains("rate_limited"),
        "the throttled path must actually have been taken: {captured:?}"
    );
    assert_no_sentinel(&captured, "rate limited");
}

#[test]
fn malformed_truncated_and_oversized_frames_log_only_the_bounded_frame_label() {
    let lister = ScriptedLister {
        list: || ListOutcome::Io,
        show: |_| ShowOutcome::Io,
        search: |_| SearchOutcome::Io,
        new_note: |_, _| NewOutcome::Io,
        daily: |_| DailyOutcome::Io,
        daily_append: |_, _| DailyAppendOutcome::Io,
        open_file: |_| OpenFileOutcome::Io,
    };
    let limiter = open_limiter();

    // A body that frames correctly but is not a request at all — and that
    // carries every sentinel, so a dispatcher tempted to echo "what we could
    // not parse" would trip here.
    let junk = format!("not json {SENTINEL_BODY} {SENTINEL_PATH} {SENTINEL_NOTE_ID}");
    // Declared length far beyond the body actually sent: truncated.
    let mut truncated = 4096u32.to_le_bytes().to_vec();
    truncated.extend_from_slice(SENTINEL_PATH.as_bytes());
    // Declared length beyond the 16 MiB cap: oversized, body never read.
    let oversized = u32::MAX.to_le_bytes().to_vec();

    let (_, captured) = capture(|| {
        serve(&framed(junk.as_bytes()), &lister, &limiter);
        serve(&truncated, &lister, &limiter);
        serve(&oversized, &lister, &limiter);
        serve(&[], &lister, &limiter); // clean EOF at a frame boundary
    });

    for label in ["truncated", "oversized", "eof"] {
        assert!(
            captured.contains(label),
            "the {label} framing path must actually have been taken: {captured:?}"
        );
    }
    assert_no_sentinel(&captured, "framing failures");
}

#[test]
fn the_capture_harness_would_actually_see_a_leak() {
    // The control for every absence assertion above: if the subscriber were
    // mis-wired, they would all pass while proving nothing. Emit a sentinel
    // deliberately and require the harness to catch it.
    let (_, captured) = capture(|| {
        tracing::trace!(stage = "cli_bridge_logging_selftest", leak = SENTINEL_BODY);
    });
    assert!(
        captured.contains(SENTINEL_BODY),
        "the capture harness must observe TRACE-level records: {captured:?}"
    );
}

// ---- source audit ---------------------------------------------------------

/// Every production source in this directory, paired with its name for the
/// failure message. `logging_discipline.rs` (this file) is excluded — it is
/// test-only and deliberately emits a sentinel in the self-test above.
const SOURCES: &[(&str, &str)] = &[
    ("activity.rs", include_str!("activity.rs")),
    ("compose.rs", include_str!("compose.rs")),
    ("daily.rs", include_str!("daily.rs")),
    ("dispatch.rs", include_str!("dispatch.rs")),
    ("framing.rs", include_str!("framing.rs")),
    ("gate.rs", include_str!("gate.rs")),
    // Test-only (declared `#[cfg(all(test, unix))]`), and audited anyway so the
    // roster above cannot quietly lose it: it drives real sockets and a real
    // child process, and a log site added here would be a log site in this
    // directory whatever the gate says.
    ("mcp_door_test.rs", include_str!("mcp_door_test.rs")),
    ("mod.rs", include_str!("mod.rs")),
    ("path_shim.rs", include_str!("path_shim.rs")),
    ("plugin.rs", include_str!("plugin.rs")),
    ("rate_limit.rs", include_str!("rate_limit.rs")),
    ("scope.rs", include_str!("scope.rs")),
    ("socket.rs", include_str!("socket.rs")),
    ("status.rs", include_str!("status.rs")),
];

/// Field names any `tracing` record in this directory may carry.
///
/// **Adding a name here is a deliberate act.** Check the value it will carry
/// against the DENY list in `src-tauri/AGENTS.md` first: note content, note
/// ids, folder names, filesystem paths and raw `io::Error` Display are all
/// forbidden, and a field like `note_id` or `path` can never be allowlisted.
const ALLOWED_FIELDS: &[&str] = &[
    "stage",
    "event",
    "outcome",
    "frame_error",
    "io_failure_kind",
    "shim_dir_on_path",
];

/// The exact non-literal value expressions allowed as a field value. Each is
/// a closed-enum label helper or a bool — never a `String`, never a `Path`,
/// never a `Display` of an `io::Error`.
const ALLOWED_VALUES: &[&str] = &[
    "e.label()",
    "outcome.label()",
    "ShimOutcome::Unsupported.label()",
    "spec.stage.label()",
    "?kind",
    "on_path",
];

/// Remove every `#[cfg(test)] mod … { … }` block, brace-matched.
///
/// Deliberately not "truncate at the first `#[cfg(test)]`": that reads as
/// correct because test modules are conventionally last, and it silently
/// stops auditing anything written after one. A file with production code
/// below its tests would be exempt from the whole audit, and nothing about
/// the omission would look wrong.
fn production_half(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut rest = source;
    loop {
        let cut = ["#[cfg(test)]", "#[cfg(all(test"]
            .iter()
            .filter_map(|marker| rest.find(marker))
            .min();
        let Some(start) = cut else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        // A `#[cfg(test)]` item with no body — `mod logging_discipline;`, a
        // `use`, a const — ends at the first `;`. Skip the attribute and its
        // one item, and keep auditing the rest of the file.
        let semi = after.find(';');
        let brace = after.find('{');
        let Some(open) = brace else {
            match semi {
                Some(s) => {
                    rest = &after[s + 1..];
                    continue;
                }
                None => return out,
            }
        };
        if semi.is_some_and(|s| s < open) {
            rest = &after[semi.expect("checked") + 1..];
            continue;
        }
        let mut depth = 0usize;
        let mut end = None;
        for (i, c) in after[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(open + i + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        match end {
            Some(e) => rest = &after[e..],
            None => return out,
        }
    }
}

/// Extract the argument text of every `tracing::<level>!( … )` invocation,
/// balanced on parentheses and blind to parentheses inside string literals
/// (a log message may contain either, and a naive counter mis-reads both).
///
/// Only `tracing::<ident>!(` counts — `tracing::Level::TRACE` and a
/// doc-comment mention of `tracing::*!` are paths and prose, not call sites.
fn tracing_invocations(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = source;
    while let Some(i) = rest.find("tracing::") {
        let after = &rest[i + "tracing::".len()..];
        let ident_len = after
            .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .unwrap_or(after.len());
        if !after[ident_len..].starts_with("!(") {
            rest = after;
            continue;
        }
        let open = ident_len + 1;
        let mut depth = 0usize;
        let mut in_string = false;
        let mut escaped = false;
        let mut end = None;
        for (j, c) in after[open..].char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            match c {
                '\\' if in_string => escaped = true,
                '"' => in_string = !in_string,
                '(' if !in_string => depth += 1,
                ')' if !in_string => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(open + j);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(end) = end else { break };
        out.push(after[open + 1..end].to_string());
        rest = &after[end..];
    }
    out
}

/// Split an invocation's arguments on top-level commas (so a `foo(a, b)`
/// value stays one argument).
fn top_level_args(invocation: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut current = String::new();
    let mut chars = invocation.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if in_string => {
                current.push(c);
                if let Some(next) = chars.next() {
                    current.push(next);
                }
                continue;
            }
            '"' => in_string = !in_string,
            '(' | '[' | '{' if !in_string => depth += 1,
            ')' | ']' | '}' if !in_string => depth -= 1,
            ',' if !in_string && depth == 0 => {
                args.push(current.trim().to_string());
                current.clear();
                continue;
            }
            _ => {}
        }
        current.push(c);
    }
    let last = current.trim();
    if !last.is_empty() {
        args.push(last.to_string());
    }
    args
}

#[test]
fn the_audited_roster_covers_every_module_this_directory_declares() {
    // The control for [`SOURCES`] itself. Every assertion below it is scoped
    // to the files that list names, so a module added to `mod.rs` and
    // forgotten here would be audited by nothing — and the omission looks
    // like nothing: no compiler error, no failing test, just a narrower
    // guarantee than the one `mod.rs` states in prose. Derive the expected
    // roster from the `mod` declarations instead of trusting a second
    // hand-written list to stay in step with the first.
    let mod_rs = SOURCES
        .iter()
        .find(|(name, _)| *name == "mod.rs")
        .expect("mod.rs is itself audited")
        .1;
    let mut declared = 0usize;
    for line in mod_rs.lines() {
        let line = line.trim();
        let Some(rest) = line
            .strip_prefix("pub mod ")
            .or_else(|| line.strip_prefix("mod "))
        else {
            continue;
        };
        let Some(module) = rest.strip_suffix(';') else {
            continue;
        };
        // This file is the auditor, not the audited: it is test-only and
        // deliberately emits a sentinel in the capture self-test above.
        if module == "logging_discipline" {
            continue;
        }
        declared += 1;
        let file = format!("{module}.rs");
        assert!(
            SOURCES.iter().any(|(name, _)| *name == file),
            "`{file}` is declared in cli_bridge/mod.rs but missing from SOURCES — \
             it would be audited by nothing. Add an `include_str!` entry."
        );
    }
    // The extractor's own control, for the same reason `seen >= 10` is one
    // below: a parse that matched no `mod` line at all would pass this test
    // while checking nothing.
    // `+ 1` is `mod.rs` itself, which is audited but declares no `mod mod;`.
    assert_eq!(
        declared + 1,
        SOURCES.len(),
        "cli_bridge/mod.rs declares {declared} audited modules but SOURCES holds \
         {} entries — one side has an entry the other does not",
        SOURCES.len()
    );
}

#[test]
fn every_tracing_call_site_carries_only_allowlisted_fields_and_bounded_values() {
    let mut seen = 0usize;
    for (name, source) in SOURCES {
        for invocation in tracing_invocations(&production_half(source)) {
            seen += 1;
            assert!(
                !invocation.contains('%'),
                "{name}: `%` Display-formatting is forbidden in this directory \
                 (src-tauri/AGENTS.md, closed-enum mapping rule): {invocation:?}"
            );
            for arg in top_level_args(&invocation) {
                // A bare message string is the one positional argument
                // `tracing` takes, and a literal cannot carry a runtime value.
                if arg.starts_with('"') {
                    continue;
                }
                let Some((field, value)) = arg.split_once('=') else {
                    panic!(
                        "{name}: a `tracing` argument that is neither a string literal \
                         nor `field = value` cannot be audited: {arg:?}"
                    );
                };
                let field = field.trim();
                let value = value.trim();
                assert!(
                    ALLOWED_FIELDS.contains(&field),
                    "{name}: `{field}` is not an allowlisted tracing field. Check the \
                     value it carries against the DENY list in src-tauri/AGENTS.md \
                     before adding it to ALLOWED_FIELDS."
                );
                assert!(
                    value.starts_with('"') || ALLOWED_VALUES.contains(&value),
                    "{name}: `{field} = {value}` is not a string literal and not an \
                     allowlisted bounded expression. Reduce it to a closed enum or a \
                     `&'static str` label first (src-tauri/AGENTS.md)."
                );
            }
        }
    }
    // The extractor must actually be finding call sites — a regex-shaped
    // audit that silently matches nothing is the same vacuous pass the
    // capture harness's self-test guards against.
    assert!(
        seen >= 10,
        "the source audit found only {seen} tracing call sites; the extractor is broken"
    );
}

#[test]
fn production_code_in_this_directory_prints_to_no_stream() {
    // A `println!`/`eprintln!` bypasses the subscriber entirely, so no
    // level filter and no capture test would ever see it. The desktop
    // process has no terminal to talk to; every diagnostic goes through
    // `tracing` or it does not exist.
    for (name, source) in SOURCES {
        let production = production_half(source);
        for forbidden in ["println!", "eprintln!", "dbg!"] {
            assert!(
                !production.contains(forbidden),
                "{name}: `{forbidden}` bypasses the tracing subscriber and its \
                 DENY-list discipline"
            );
        }
    }
}

#[test]
fn the_wire_error_message_vocabulary_is_closed() {
    // `dispatch::encode_err` takes `message: &'static str`, so the desktop
    // structurally cannot put a runtime string on the wire — which is what
    // lets the CLI forward an unrecognized kind's message verbatim
    // (`backend::ipc::map_wire_error`) without that being a channel for a
    // path or an `io::Error` Display. Pin the signature, because relaxing it
    // to `String` would compile fine on both sides and open exactly that
    // channel.
    let dispatch_src = production_half(include_str!("dispatch.rs"));
    assert!(
        dispatch_src.contains("fn encode_err(kind: &'static str, message: &'static str)"),
        "encode_err must keep its `&'static str` message parameter — a `String` \
         there is how a path reaches the CLI's stderr and its --json error field"
    );
}

#[test]
fn the_path_shim_reports_outcomes_as_labels_never_as_paths() {
    // `path_shim::reconcile` runs on the startup thread and logs the outcome
    // of a directory write — the one place in this directory that handles a
    // path at all. Its label vocabulary must stay path-free.
    use super::path_shim::ShimOutcome;
    for outcome in [
        ShimOutcome::Installed,
        ShimOutcome::Unchanged,
        ShimOutcome::SidecarAbsent,
        ShimOutcome::SidecarAlreadyOnPath,
        ShimOutcome::ForeignOnPath,
        ShimOutcome::Unsupported,
        ShimOutcome::Failed(myne_core::io_failure_kind::IoFailureKind::PermissionDenied),
    ] {
        let label = outcome.label();
        assert!(
            !label.contains('/') && !label.contains('\\') && !label.contains('.'),
            "shim outcome label {label:?} is path-shaped"
        );
    }
}

#[test]
fn the_one_path_that_crosses_a_boundary_here_crosses_only_the_webview_reply() {
    // The audit's one carve-out, written down rather than left implicit.
    //
    // `path_shim::shim_dir_for_display` returns a full filesystem path, and
    // the DENY list names those for IPC payloads as well as for logs. Task 12
    // took it across the WebView boundary deliberately: `~/.local/bin` is not
    // on `$PATH` by default on macOS, and the honest fix is one `export
    // PATH="…:$PATH"` line the user pastes — a redacted path is a line that
    // does not work, and the value is the app's own install directory under
    // the user's home, not vault-derived and not secret.
    //
    // What must not drift is the *reach* of that value: it may travel to the
    // Settings panel that asked for it, and nowhere else. So it appears in
    // exactly one caller, and that caller does no logging.
    let plugin = production_half(include_str!("plugin.rs"));
    let callers: Vec<_> = SOURCES
        .iter()
        .filter(|(name, source)| {
            *name != "path_shim.rs" && production_half(source).contains("shim_dir_for_display")
        })
        .map(|(name, _)| *name)
        .collect();
    assert_eq!(
        callers,
        vec!["plugin.rs"],
        "the shim directory may only reach the Settings reply; a second caller \
         needs the DENY-list carve-out re-argued, not copied"
    );
    assert!(
        tracing_invocations(&plugin).is_empty(),
        "plugin.rs must stay logging-free: the value it handles is the one path \
         in this directory that is allowed across a boundary at all"
    );
}
