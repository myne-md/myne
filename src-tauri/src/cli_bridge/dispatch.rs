// SPDX-License-Identifier: AGPL-3.0
//! JSON command dispatch for the CLI bridge command socket (cli-thin-client
//! task 4; MYND-490).
//!
//! ## Wire contract
//!
//! One JSON object per length-prefixed frame ([`super::framing`]), each
//! direction:
//!
//! - Request: `{"cmd": "<name>", ...}`.
//! - Response: `{"ok": true, ...}` on success, or
//!   `{"ok": false, "error": {"kind": "<wire kind>", "message": "<text>"}}`
//!   on failure. `kind` is a closed vocabulary (`vault_locked` / `io` /
//!   `invalid_request` / `rate_limited`) the `cli/` crate maps to a distinct
//!   exit code.
//!
//! **This module is NOT a dependency of the `cli/` crate and vice versa** —
//! same reasoning as [`super::framing`]'s own doc comment: a wire
//! *contract*, not shared Rust types, so the CLI binary never depends on
//! `myne-desktop`. The `cli/` crate decodes/encodes this exact shape with
//! its own copy.
//!
//! ## Testability
//!
//! [`serve_connection`] is generic over `Read`/`Write` and takes the
//! vault-state seam as `&dyn NoteLister` — the same shape
//! `clipper::relay::serve_connection` already uses for its own app-state
//! seams (`VaultStatusSource`, `ClipAssembler`). This is what lets the
//! decode → dispatch → encode loop run in a unit test over an in-memory
//! pipe with a fake [`NoteLister`], with no `AppHandle` / `tauri::test`
//! harness (core/AGENTS.md's stated reason for avoiding that harness: the
//! TB9 Cargo.lock discipline). The production seam, [`AppNoteLister`],
//! bridges the real async `note_list_from_host` call via
//! `tauri::async_runtime::block_on` — the same bridge
//! `clipper::relay_app::AppVaultStatus` already uses for its own
//! `VaultStatusSource` impl. It then filters the result through
//! [`crate::cli_bridge::scope::filter_note_ids_by_scope`] (task 5) before
//! returning — the ids this trait hands back are already in-scope, so a
//! `NoteLister` caller never has to remember to filter.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline" — a `list`
//! reply body carries note ids only (a vault-stable correlation tag, same
//! DENY class as salts/nonces per that doc); this module never logs a
//! request/response body, only the bounded outcome tags below.

use std::io::{Read, Write};

use serde::{Deserialize, Serialize};

use super::framing;
use super::rate_limit::{RateDecision, SharedRateLimiter};

/// The request shapes this module dispatches.
#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum Request {
    List,
    Show {
        id: String,
    },
    Search {
        query: String,
    },
    New {
        body: String,
        #[serde(default)]
        folder: Option<String>,
    },
    Daily,
    DailyAppend {
        line: String,
    },
    /// myne#177. `period` is the wire spelling (`daily` / `weekly` /
    /// `monthly`); an unknown one is refused rather than defaulted.
    Period {
        period: String,
    },
    PeriodAppend {
        period: String,
        line: String,
    },
    /// myne-md/myne#788 (plaintext-file-editor task 11). Opens a local
    /// markdown file in the plain-file surface of the RUNNING app. `path` is
    /// the one wire field in this module that is filesystem-shaped: the
    /// desktop re-validates it (gate, extension on the canonical path, size)
    /// before anything is read, and this process never reads it on its own
    /// behalf. See [`OpenFileOutcome`].
    Open {
        path: String,
    },
    /// external-mcp-connection (myne-md/myne#923). The `myne-mcp` sidecar's
    /// `tools/call`, forwarded over the SAME socket as every CLI command.
    ///
    /// Three fields, and none of them is a scope: `connection` is the name the
    /// client declared (the shim writes `MYNE_MCP_CONNECTION` into its config,
    /// so this is the name the USER approved), `tool` is the verb and
    /// `arguments` are the caller's own bytes. What may be read is resolved
    /// host-side from the stored grant — see [`McpCallOutcome`].
    McpCall {
        /// The declared connection name. Required: a call that names nothing is
        /// a malformed request, not an owner call, and the shim always fills
        /// this in (`unnamed-client` when nothing names the connection).
        connection: String,
        /// The verb, as the shim spelled it.
        tool: String,
        /// The caller's arguments. `Value::Null` when the field is absent, which
        /// decodes as a malformed request rather than as "no arguments".
        #[serde(default)]
        arguments: serde_json::Value,
    },
}

/// One search hit on the wire: an id + its title, nothing else. No score,
/// no snippet, no `matched_in` badge — task 7's own scope is "prints
/// matching notes with ids and titles", and every extra field is one more
/// thing the oracle discipline below would have to reason about.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SearchHitWire {
    pub id: String,
    pub title: String,
}

/// Closed outcome of a `list` request against the vault-state seam. Not a
/// 1:1 mirror of `myne_core::plugins::notes::error::NoteListError` — the
/// wire only distinguishes what the CLI's exit-code map (task 4's own
/// acceptance criteria) needs to distinguish; every other failure
/// collapses to `Io`.
pub enum ListOutcome {
    Ok(Vec<String>),
    /// The vault locked between the socket accepting this connection and
    /// the request executing — a narrow race (the supervisor tears the
    /// socket down within one tick of a lock), not the common case.
    VaultLocked,
    Io,
}

/// Closed outcome of a `show` request (task 6). `NotFound` covers both an
/// unknown/malformed note id AND an excluded one — see
/// [`crate::cli_bridge::scope::body_out_of_scope_from_host`]'s doc comment for
/// why those two must stay indistinguishable at every layer, this one
/// included.
pub enum ShowOutcome {
    Ok(String),
    NotFound,
    /// Same narrow race as `ListOutcome::VaultLocked`.
    VaultLocked,
    Io,
}

/// Closed outcome of a `search` request (task 7). No "N results were
/// hidden" case exists anywhere in this enum — an excluded hit and a
/// genuine no-match both collapse into `Ok(vec![])`, which is the whole
/// point (see [`crate::cli_bridge::scope::search_in_scope`]'s doc comment).
pub enum SearchOutcome {
    Ok(Vec<SearchHitWire>),
    /// Same narrow race as `ListOutcome::VaultLocked`.
    VaultLocked,
    Io,
}

/// Closed outcome of a `new` request (task 8). `FolderExcluded` is the
/// write-path twin of `show`'s `NotFound` — an EXPLICIT wire-visible refusal
/// (not folded into `Io`), because task 8's own acceptance criteria demand a
/// distinct exit code the CLI can branch on ("refused, nothing written" is a
/// different user situation than a generic failure).
pub enum NewOutcome {
    /// The new note's id — the same string `note_create_from_host` returns.
    Ok(String),
    /// The requested destination folder (or one of its ancestors) is in
    /// `cli_excluded_folders`. Checked BEFORE the core create path runs, so
    /// nothing is ever written on this outcome.
    FolderExcluded,
    /// The `folder` argument is not a folder path at all — it carries a
    /// control character, which would break out of the frontmatter VALUE and
    /// become additional frontmatter lines
    /// ([`crate::cli_bridge::compose::folder_arg_has_control_char`]). Refused
    /// before normalization, so nothing is written and no scope check is ever
    /// asked about a destination that is not the real one.
    InvalidFolder,
    /// Same narrow race as `ListOutcome::VaultLocked`.
    VaultLocked,
    Io,
}

/// Closed outcome of a `daily` request (task 9) — the same open-or-create
/// contract `show` uses (`Ok` carries the resolved note's markdown body).
/// `FolderExcluded` fires when the CONFIGURED daily folder is in
/// `cli_excluded_folders`, checked before any scan or write runs (task 9's
/// own text: "never a silent no-op").
pub enum DailyOutcome {
    /// The note's markdown, plus whether the device clock was used in place of
    /// a display-timezone override (myne#177). A flag, never the sentence: the
    /// CLI owns the wording so no host-supplied bytes reach its stderr.
    Ok(String, bool),
    FolderExcluded,
    /// Same narrow race as `ListOutcome::VaultLocked`.
    VaultLocked,
    /// A period spelling this host does not know (myne#177). Distinct from
    /// `Io` on purpose: refusing rather than defaulting only helps if a newer
    /// client can tell version skew from a failing disk, and "an internal
    /// error occurred" says the opposite of what happened.
    UnknownPeriod,
    Io,
}

/// Closed outcome of a `daily_append` request (task 9). `Ok` carries only the
/// optional device-clock flag (myne#177). Success is otherwise silent, matching
/// the `>>` mental model this command restores.
pub enum DailyAppendOutcome {
    /// Whether the device clock was used in place of a display-timezone
    /// override (myne#177). A flag, never the sentence: see `DailyOutcome::Ok`.
    Ok(bool),
    FolderExcluded,
    /// Same narrow race as `ListOutcome::VaultLocked`.
    VaultLocked,
    /// See [`DailyOutcome::UnknownPeriod`].
    UnknownPeriod,
    Io,
}

/// Closed outcome of an `open` request (myne-md/myne#788, task 11).
///
/// The gate refusal gets its own wire kind because the CLI's exit-code map is
/// the user-facing contract ("a script can branch without parsing text"), and
/// "you have not enabled this feature" is a different situation from a disk
/// failure. The rest collapse into the kinds the CLI already knows.
pub enum OpenFileOutcome {
    /// A handle was minted and the frontend told.
    Ok,
    /// The device-local plain-file gate is off: nothing was read.
    PlainFileOff,
    /// Not a `.md` / `.markdown` file (checked on the canonical path).
    UnsupportedFile,
    /// Missing, a directory, or a name the surface cannot present. Maps to
    /// the CLI's existing `not_found`, which is what a missing argument path
    /// most often is.
    NotFound,
    /// Over the plain-file size cap; refused before any read.
    TooLarge,
    Io,
}

/// The vault-state seam [`serve_connection`] dispatches through. `&dyn`,
/// not `AppHandle<R>` — so a test can supply a fake with no Tauri runtime
/// at all (mirrors `clipper::envelope::VaultStatusSource`).
///
/// **The name is historical.** It began as the note commands, and it now
/// carries every command this door answers (`new`, `daily`, `open`, and the
/// MCP surface's `mcp_call`), because one seam is what keeps the rate limiter,
/// the reply envelope and the one-request-per-connection contract in ONE place.
/// Renaming it is a mechanical change across this file and its doubles, worth
/// doing on its own rather than folded into a feature slice.
pub trait NoteLister: Send + Sync {
    fn list_notes(&self) -> ListOutcome;
    fn show_note(&self, id: &str) -> ShowOutcome;
    fn search_notes(&self, query: &str) -> SearchOutcome;
    fn create_note(&self, body: &str, folder: Option<&str>) -> NewOutcome;
    /// `period` is the wire spelling; the implementation refuses one it does
    /// not know (myne#177). `daily` and `daily_append` reach these with
    /// `"daily"`, so the pre-#177 wire commands keep working unchanged.
    fn period(&self, period: &str) -> DailyOutcome;
    fn period_append(&self, period: &str, line: &str) -> DailyAppendOutcome;
    /// Open a local markdown file in the running app's plain-file surface
    /// (myne-md/myne#788). The CLI never reads the file; the implementation
    /// resolves it through the same gate-checked ingest every other ingress
    /// uses.
    fn open_plain_file(&self, path: &str) -> OpenFileOutcome;
    /// One external MCP connection's `tools/call` (external-mcp-connection,
    /// myne-md/myne#923). The implementation resolves the connection's stored
    /// grant, clamps the verb to it and returns a complete MCP `CallToolResult`
    /// — see [`McpCallOutcome`].
    ///
    /// Synchronous like every other command here: this trait is called from a
    /// connection thread, and the production implementation is the one that
    /// bridges to the async core (`tauri::async_runtime::block_on`), exactly as
    /// the seven above do.
    fn mcp_call(&self, request: McpCallRequest) -> McpCallOutcome;
}

/// One `mcp_call`, as the wire carried it.
#[derive(Debug, Clone, PartialEq)]
pub struct McpCallRequest {
    /// The connection name the shim declared. Trimmed and matched EXACTLY
    /// against the stored grants: normalization happens when a grant is
    /// written, so two spellings that differ only by composition are two names
    /// here on purpose (`cli_bridge` has no opinion about names).
    pub connection: String,
    /// The verb, as the shim spelled it.
    pub tool: String,
    /// The caller's arguments, verbatim.
    pub arguments: serde_json::Value,
}

/// What one `mcp_call` decided, as the door relays it.
///
/// Re-exported from `myne_core::plugins::mcp::tools` rather than mirrored: the
/// host-side decision is core's, and a second enum here would be a second place
/// for a refusal to gain or lose a case.
pub use myne_core::plugins::mcp::tools::McpCallOutcome;

/// WebView event fired after a CLI write lands (#258).
///
/// The name is duplicated-by-design on the TS side (`src/screens/Editor.tsx`),
/// like every other Tauri event name in this tree — nothing relates a Rust
/// string literal to a TS listener, so keep the two in step by hand.
pub const CLI_NOTES_CHANGED_EVENT: &str = "myne://cli-notes-changed";

fn handle_request(lister: &dyn NoteLister, request_body: &[u8]) -> Vec<u8> {
    let request: Request = match serde_json::from_slice(request_body) {
        Ok(r) => r,
        Err(_) => return encode_err("invalid_request", "malformed request"),
    };
    match request {
        Request::List => match lister.list_notes() {
            ListOutcome::Ok(notes) => encode_ok_notes(&notes),
            ListOutcome::VaultLocked => {
                encode_err("vault_locked", "the vault locked during this request")
            }
            ListOutcome::Io => encode_err("io", "an internal error occurred"),
        },
        Request::Show { id } => match lister.show_note(&id) {
            ShowOutcome::Ok(body) => encode_ok_body(&body, false),
            ShowOutcome::NotFound => encode_err("not_found", "no matching note"),
            ShowOutcome::VaultLocked => {
                encode_err("vault_locked", "the vault locked during this request")
            }
            ShowOutcome::Io => encode_err("io", "an internal error occurred"),
        },
        Request::Search { query } => match lister.search_notes(&query) {
            SearchOutcome::Ok(hits) => encode_ok_search(&hits),
            SearchOutcome::VaultLocked => {
                encode_err("vault_locked", "the vault locked during this request")
            }
            SearchOutcome::Io => encode_err("io", "an internal error occurred"),
        },
        Request::New { body, folder } => match lister.create_note(&body, folder.as_deref()) {
            NewOutcome::Ok(id) => encode_ok_id(&id),
            NewOutcome::FolderExcluded => {
                encode_err("folder_excluded", "that folder is excluded from CLI access")
            }
            NewOutcome::InvalidFolder => encode_err(
                "invalid_request",
                "a folder path cannot contain a control character",
            ),
            NewOutcome::VaultLocked => {
                encode_err("vault_locked", "the vault locked during this request")
            }
            NewOutcome::Io => encode_err("io", "an internal error occurred"),
        },
        Request::Daily => dispatch_period(lister, "daily"),
        Request::Period { period } => dispatch_period(lister, &period),
        Request::PeriodAppend { period, line } => dispatch_period_append(lister, &period, &line),
        Request::DailyAppend { line } => dispatch_period_append(lister, "daily", &line),
        Request::Open { path } => match lister.open_plain_file(&path) {
            OpenFileOutcome::Ok => encode_ok(),
            OpenFileOutcome::PlainFileOff => encode_err(
                "plain_file_off",
                "the local-file editor is off; enable it in the app's Settings",
            ),
            OpenFileOutcome::UnsupportedFile => {
                encode_err("unsupported_file", "only .md and .markdown files open here")
            }
            OpenFileOutcome::NotFound => encode_err("not_found", "no such file"),
            OpenFileOutcome::TooLarge => encode_err("too_large", "that file is too large to open"),
            OpenFileOutcome::Io => encode_err("io", "an internal error occurred"),
        },
        Request::McpCall {
            connection,
            tool,
            arguments,
        } => match lister.mcp_call(McpCallRequest {
            connection,
            tool,
            arguments,
        }) {
            // A refusal names its own closed reason as the wire `kind`, so the
            // shim's `structuredContent.reason` and this envelope cannot drift:
            // the shim relays `kind` verbatim and validates only that it is a
            // wire label.
            McpCallOutcome::Result(result) => encode_ok_result(&result),
            McpCallOutcome::Refused(error) => encode_err(error.reason(), error.message()),
            // Version skew, not a scope decision: this build does not implement
            // that verb. The same shape `period` uses for a period it does not
            // know, because a newer client must be able to tell skew from a
            // failing disk.
            McpCallOutcome::UnknownTool => {
                encode_err("invalid_request", "this app does not know that tool")
            }
            McpCallOutcome::Malformed => encode_err("invalid_request", "malformed request"),
            McpCallOutcome::VaultLocked => {
                encode_err("vault_locked", "the vault locked during this request")
            }
            McpCallOutcome::Io => encode_err("io", "an internal error occurred"),
        },
    }
}

/// The `daily` / `weekly` / `monthly` reply (myne#177).
fn dispatch_period(lister: &dyn NoteLister, period: &str) -> Vec<u8> {
    match lister.period(period) {
        DailyOutcome::Ok(body, used_device_clock) => encode_ok_body(&body, used_device_clock),
        DailyOutcome::FolderExcluded => {
            encode_err("folder_excluded", "that folder is excluded from CLI access")
        }
        DailyOutcome::VaultLocked => {
            encode_err("vault_locked", "the vault locked during this request")
        }
        DailyOutcome::UnknownPeriod => {
            encode_err("invalid_request", "this app does not know that period")
        }
        DailyOutcome::Io => encode_err("io", "an internal error occurred"),
    }
}

/// The `daily:append` / `weekly:append` / `monthly:append` reply (myne#177).
fn dispatch_period_append(lister: &dyn NoteLister, period: &str, line: &str) -> Vec<u8> {
    match lister.period_append(period, line) {
        DailyAppendOutcome::Ok(used_device_clock) => encode_ok_note(used_device_clock),
        DailyAppendOutcome::FolderExcluded => {
            encode_err("folder_excluded", "that folder is excluded from CLI access")
        }
        DailyAppendOutcome::VaultLocked => {
            encode_err("vault_locked", "the vault locked during this request")
        }
        DailyAppendOutcome::UnknownPeriod => {
            encode_err("invalid_request", "this app does not know that period")
        }
        DailyAppendOutcome::Io => encode_err("io", "an internal error occurred"),
    }
}

fn encode_ok_notes(notes: &[String]) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "ok": true, "notes": notes }))
        .unwrap_or_else(|_| encode_err("io", "response encode failure"))
}

/// `show`'s success reply. The note body is exactly what this exists to
/// carry across the wire — not logged anywhere, per this module's own DENY
/// discipline note above.
fn encode_ok_body(body: &str, used_device_clock: bool) -> Vec<u8> {
    // A FLAG, not the sentence: the CLI owns the wording, so no host-supplied
    // bytes can reach its stderr (see `daily.rs` for why that matters). OMITTED
    // when false (myne#177), so a reply to a client that predates the field is
    // byte-identical to what it was, and the field is additive rather than
    // breaking.
    let mut value = serde_json::json!({ "ok": true, "body": body });
    if let (true, Some(obj)) = (used_device_clock, value.as_object_mut()) {
        obj.insert("used_device_clock".into(), serde_json::json!(true));
    }
    serde_json::to_vec(&value).unwrap_or_else(|_| encode_err("io", "response encode failure"))
}

/// A bare `{"ok": true}`, plus the device-clock flag when it applies.
fn encode_ok_note(used_device_clock: bool) -> Vec<u8> {
    match used_device_clock {
        false => encode_ok(),
        true => serde_json::to_vec(&serde_json::json!({
            "ok": true,
            "used_device_clock": true,
        }))
        .unwrap_or_else(|_| encode_err("io", "response encode failure")),
    }
}

/// `search`'s success reply. **No field beyond `results` may ever appear
/// here** — a count, a "was anything hidden" bool, anything at all beyond
/// the array itself, would be exactly the oracle task 7 exists to close off
/// (`crate::cli_bridge::scope::search_in_scope`'s doc comment).
fn encode_ok_search(hits: &[SearchHitWire]) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "ok": true, "results": hits }))
        .unwrap_or_else(|_| encode_err("io", "response encode failure"))
}

/// `new`'s success reply — the new note's id, the one piece of information a
/// script piping `myne new`'s output needs (e.g. to `myne show` it right
/// back). Not a DENY-listed value across THIS boundary: `note_id` is DENY-
/// listed for `tracing`/log output (a vault-stable correlation tag), but the
/// wire reply crossing back to the CLI that just minted it is the one place
/// that id is supposed to go — the same distinction `show`'s `body` field
/// already draws between "never logged" and "the whole point of the reply".
fn encode_ok_id(id: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "ok": true, "id": id }))
        .unwrap_or_else(|_| encode_err("io", "response encode failure"))
}

/// `daily_append`'s success reply — no payload beyond `ok`, matching the
/// silent-success shape of `>>` this command restores.
fn encode_ok() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "ok": true })).expect("static ok shape always encodes")
}

/// `mcp_call`'s success reply: the complete MCP `CallToolResult` under `result`.
///
/// The shim checks only that `result` carries a `content` array before relaying
/// it verbatim, so this is the one place a malformed success could reach a
/// client's transcript — which is why the value came from a typed tool answer
/// rather than from a string built here.
fn encode_ok_result(result: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "ok": true, "result": result }))
        .unwrap_or_else(|_| encode_err("io", "response encode failure"))
}

fn encode_err(kind: &'static str, message: &'static str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "ok": false,
        "error": { "kind": kind, "message": message }
    }))
    .expect("static error shape always encodes")
}

/// Serve exactly one command-socket connection: read exactly one bounded
/// frame, dispatch it against `lister`, write exactly one reply frame, then
/// return. One request per connection — not a loop like the clipper
/// relay's — because the CLI (task 4's `IpcBackend`) opens a fresh
/// connection per invocation; there is no keep-alive to serve.
///
/// Never panics on malformed input: a frame that fails to decode, or a body
/// that isn't the expected JSON shape, produces a typed error reply rather
/// than propagating.
///
/// `limiter` is the process-wide command-socket rate limit (task 10). An
/// over-budget request is answered with the `rate_limited` kind and
/// `lister` is never touched — the reply is immediate, so the caller gets a
/// distinct exit code instead of a hang.
pub fn serve_connection<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    lister: &dyn NoteLister,
    limiter: &SharedRateLimiter,
    // A wall-clock ceiling on reading the REQUEST, and on nothing else. The
    // socket's `SO_RCVTIMEO` is per-syscall and so bounds a silent peer but not
    // a dribbling one; see `framing::Budget`. Deliberately not a bound on what
    // follows: dispatch decrypts every candidate note, so a ceiling spanning it
    // would be a compute cap that kills a healthy `myne list` on a large vault.
    // `None` in tests that read from a cursor, where there is no peer to pace.
    read_budget: Option<framing::Budget>,
) {
    let body = match framing::read_frame_within(reader, read_budget) {
        Ok(b) => b,
        Err(e) => {
            tracing::debug!(stage = "cli_bridge_conn", frame_error = e.label());
            return;
        }
    };
    // The limiter gates requests the door would otherwise answer, and is
    // checked before the request is even parsed, so a flood costs the
    // sender a decode-and-refuse rather than a whole-vault scan. A frame
    // that never decoded (above) never reaches it — a malformed-frame
    // burst cannot eat a working caller's window.
    if limiter.check(std::time::Instant::now()) == RateDecision::Throttled {
        tracing::debug!(stage = "cli_bridge_conn", event = "rate_limited");
        let reply = encode_err(
            "rate_limited",
            "too many requests in a short time; wait a moment, \
             or turn the CLI rate limit off in Settings",
        );
        if let Err(e) = framing::write_frame(writer, &reply) {
            tracing::debug!(stage = "cli_bridge_conn", frame_error = e.label());
        }
        return;
    }
    let reply = handle_request(lister, &body);
    if let Err(e) = framing::write_frame(writer, &reply) {
        tracing::debug!(stage = "cli_bridge_conn", frame_error = e.label());
    }
}

// ---- production seam: bridges the real vault state ------------------------

#[cfg(unix)]
mod app_seam {
    use tauri::{AppHandle, Manager, Runtime};

    use super::{
        DailyAppendOutcome, DailyOutcome, ListOutcome, McpCallOutcome, McpCallRequest, NewOutcome,
        NoteLister, OpenFileOutcome, SearchHitWire, SearchOutcome, ShowOutcome,
    };

    /// Production [`NoteLister`] over the running app. Cheap to construct
    /// per-connection (just holds the handle) — mirrors
    /// `clipper::relay_app::AppVaultStatus`.
    pub struct AppNoteLister<R: Runtime> {
        app: AppHandle<R>,
    }

    impl<R: Runtime> AppNoteLister<R> {
        pub fn new(app: AppHandle<R>) -> Self {
            Self { app }
        }

        /// Tell the WebView that a note changed underneath it (#258).
        ///
        /// The CLI writes into the SAME vault the editor has open, and nothing
        /// here told the editor. An open pane holds the note's content and its
        /// base hash from the moment it loaded, so `myne daily --append` landed
        /// on disk and the next autosave wrote the pane's stale body straight
        /// over it. With sync off there is no base-hash guard to catch it, and
        /// the snapshot window hides the loss: the overwriting save coalesces
        /// with the pane's earlier ones, so the CLI's line never gets a
        /// revision of its own to restore from. `myne new` had the same missing
        /// invalidation in its milder form — the note existed but did not appear
        /// in the sidebar until a restart.
        ///
        /// Best-effort: a failed emit leaves the editor stale, which is exactly
        /// where it was before, and must never fail the CLI's write.
        fn notify_notes_changed(&self) {
            use tauri::Emitter;
            let _ = self.app.emit(super::CLI_NOTES_CHANGED_EVENT, ());
        }
    }

    impl<R: Runtime> NoteLister for AppNoteLister<R> {
        fn list_notes(&self) -> ListOutcome {
            use myne_core::plugins::notes::commands::note_list_from_host;
            use myne_core::plugins::notes::error::NoteListError;

            use crate::cli_bridge::scope::{filter_note_ids_by_scope, ScopeError};

            let Some(state) = self
                .app
                .try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()
            else {
                return ListOutcome::Io;
            };
            let host = myne_core::host::tauri_host::TauriHost::new(self.app.clone());
            let io = myne_core::vault_io::StdVaultIo;
            let result = tauri::async_runtime::block_on(async {
                let ids = match note_list_from_host(&host, state.inner(), &io).await {
                    Ok(ids) => ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
                    Err(NoteListError::VaultNotUnlocked) => return Err(ScopeError::VaultLocked),
                    Err(_) => return Err(ScopeError::Io),
                };
                // Central scope enforcement (task 5): every note this command
                // hands back must clear the exclusion filter, applied here
                // rather than trusted to a future per-command opt-in.
                filter_note_ids_by_scope(&host, state.inner(), &io, ids).await
            });
            match result {
                Ok(ids) => ListOutcome::Ok(ids),
                Err(ScopeError::VaultLocked) => ListOutcome::VaultLocked,
                Err(ScopeError::Io) => ListOutcome::Io,
            }
        }

        fn show_note(&self, id: &str) -> ShowOutcome {
            use myne_core::plugins::notes::commands::note_read_from_host;
            use myne_core::plugins::notes::error::NoteReadError;

            use crate::cli_bridge::scope::{body_out_of_scope_from_host, ScopeError};

            let Some(state) = self
                .app
                .try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()
            else {
                return ShowOutcome::Io;
            };
            let host = myne_core::host::tauri_host::TauriHost::new(self.app.clone());
            let io = myne_core::vault_io::StdVaultIo;
            tauri::async_runtime::block_on(async {
                let body =
                    match note_read_from_host(&host, state.inner(), id.to_string(), &io).await {
                        Ok(body) => body,
                        Err(NoteReadError::VaultNotUnlocked) => return ShowOutcome::VaultLocked,
                        // A malformed or unknown id gets the same reply as an
                        // excluded one, below — see `ShowOutcome::NotFound`'s
                        // doc comment.
                        Err(NoteReadError::NoteNotFound) | Err(NoteReadError::InvalidNoteId) => {
                            return ShowOutcome::NotFound
                        }
                        Err(_) => return ShowOutcome::Io,
                    };
                // Central scope enforcement (task 5): an excluded note — or a
                // trashed/tombstoned/template one, which is out of scope for
                // the same reason it is absent from every list in the app —
                // must be indistinguishable from an unknown one, so this maps
                // to the exact same `NotFound` outcome above rather than a
                // separate wire-visible case.
                match body_out_of_scope_from_host(&host, state.inner(), &io, &body).await {
                    Ok(true) => ShowOutcome::NotFound,
                    Ok(false) => ShowOutcome::Ok(body),
                    Err(ScopeError::VaultLocked) => ShowOutcome::VaultLocked,
                    Err(ScopeError::Io) => ShowOutcome::Io,
                }
            })
        }

        fn search_notes(&self, query: &str) -> SearchOutcome {
            use crate::cli_bridge::scope::{search_in_scope, ScopeError};

            let Some(state) = self
                .app
                .try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()
            else {
                return SearchOutcome::Io;
            };
            let Some(search) = self.app.try_state::<myne_core::search::SearchIndexState>() else {
                return SearchOutcome::Io;
            };
            let host = myne_core::host::tauri_host::TauriHost::new(self.app.clone());
            let io = myne_core::vault_io::StdVaultIo;
            let result = tauri::async_runtime::block_on(search_in_scope(
                &host,
                state.inner(),
                &io,
                search.inner(),
                query,
            ));
            match result {
                Ok(hits) => SearchOutcome::Ok(
                    hits.into_iter()
                        .map(|(id, title)| SearchHitWire { id, title })
                        .collect(),
                ),
                Err(ScopeError::VaultLocked) => SearchOutcome::VaultLocked,
                Err(ScopeError::Io) => SearchOutcome::Io,
            }
        }

        fn create_note(&self, body: &str, folder: Option<&str>) -> NewOutcome {
            use myne_core::plugins::notes::commands::note_create_from_host;
            use myne_core::plugins::notes::error::NoteCreateError;

            use crate::cli_bridge::compose::{
                compose_plaintext, folder_arg_has_control_char, normalize_folder_path,
            };
            use crate::cli_bridge::scope::{folder_excluded_from_host, folder_of, ScopeError};

            let Some(state) = self
                .app
                .try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()
            else {
                return NewOutcome::Io;
            };
            let Some(hooks) = self.app.try_state::<myne_core::hooks::Hooks>() else {
                return NewOutcome::Io;
            };
            let host = myne_core::host::tauri_host::TauriHost::new(self.app.clone());
            let io = myne_core::vault_io::StdVaultIo;
            // Ahead of everything else: a control character in the folder
            // argument is not a folder path, it is a frontmatter line break
            // (see `compose::folder_arg_has_control_char`). Refusing here is
            // what keeps the scope check below asking about the destination
            // the note will ACTUALLY land in.
            if folder.is_some_and(folder_arg_has_control_char) {
                return NewOutcome::InvalidFolder;
            }
            let folder = folder.and_then(normalize_folder_path);
            tauri::async_runtime::block_on(async {
                let plaintext = compose_plaintext(body, folder.as_deref());
                // Central scope enforcement (task 5): a write into an
                // excluded destination is refused BEFORE the core create
                // path ever runs, so a refusal writes nothing.
                //
                // Checked against the EFFECTIVE destination — the `folder:`
                // the composed plaintext actually reads back as — rather than
                // against the `--folder` argument alone. `note_create` is
                // dialect-blind: whatever frontmatter is in this string is
                // where the note lands, and a caller supplying its own
                // `---\nfolder: Private/\n---` body with no `--folder` at all
                // would otherwise be measured against `None` and allowed
                // straight into the folder the user excluded.
                let destination = folder_of(&plaintext);
                match folder_excluded_from_host(&host, state.inner(), &io, destination.as_deref())
                    .await
                {
                    Ok(true) => return NewOutcome::FolderExcluded,
                    Ok(false) => {}
                    Err(ScopeError::VaultLocked) => return NewOutcome::VaultLocked,
                    Err(ScopeError::Io) => return NewOutcome::Io,
                }
                match note_create_from_host(&host, state.inner(), hooks.inner(), plaintext, &io)
                    .await
                {
                    Ok(id) => {
                        self.notify_notes_changed();
                        NewOutcome::Ok(id)
                    }
                    Err(NoteCreateError::VaultNotUnlocked) => NewOutcome::VaultLocked,
                    Err(_) => NewOutcome::Io,
                }
            })
        }

        fn period(&self, period: &str) -> DailyOutcome {
            use crate::cli_bridge::daily::{period_show, DailyError};
            use myne_core::plugins::notes::daily_match::Period;

            // An unknown period is REFUSED, never defaulted to daily: a client
            // asking for a period this host does not know is a version skew,
            // and answering it with a different note is the silent-wrong-answer
            // shape the whole wire is written to avoid (myne#177).
            let Some(period) = Period::from_wire(period) else {
                return DailyOutcome::UnknownPeriod;
            };
            let Some(state) = self
                .app
                .try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()
            else {
                return DailyOutcome::Io;
            };
            let Some(hooks) = self.app.try_state::<myne_core::hooks::Hooks>() else {
                return DailyOutcome::Io;
            };
            let host = myne_core::host::tauri_host::TauriHost::new(self.app.clone());
            let io = myne_core::vault_io::StdVaultIo;
            let result = tauri::async_runtime::block_on(period_show(
                &host,
                state.inner(),
                hooks.inner(),
                &io,
                period,
            ));
            match result {
                Ok((body, used_device_clock)) => DailyOutcome::Ok(body, used_device_clock),
                Err(DailyError::FolderExcluded) => DailyOutcome::FolderExcluded,
                Err(DailyError::VaultLocked) => DailyOutcome::VaultLocked,
                Err(DailyError::Io) => DailyOutcome::Io,
            }
        }

        /// Open a local file in the plain-file surface (myne-md/myne#788).
        ///
        /// The path arrives from the CLI's argv, which is the user's own
        /// shell, and it is treated as hostile anyway: the ingest gate-checks
        /// it, canonicalises it and checks the extension and the size cap on
        /// the canonical path before anything is read. No content, no path
        /// and no handle crosses back over the socket: the tab appears in the
        /// app through the same event every other ingress uses.
        fn open_plain_file(&self, path: &str) -> OpenFileOutcome {
            use crate::plugins::plain_file::handles::PlainFileError;
            use crate::plugins::plain_file::ingest::ingest_paths_reporting;

            match ingest_paths_reporting(&self.app, vec![std::path::PathBuf::from(path)]) {
                Ok(()) => OpenFileOutcome::Ok,
                Err(PlainFileError::GateOff) => OpenFileOutcome::PlainFileOff,
                Err(PlainFileError::UnsupportedExtension) => OpenFileOutcome::UnsupportedFile,
                Err(PlainFileError::NotAFile) => OpenFileOutcome::NotFound,
                Err(PlainFileError::TooLarge) => OpenFileOutcome::TooLarge,
                Err(_) => OpenFileOutcome::Io,
            }
        }

        fn period_append(&self, period: &str, line: &str) -> DailyAppendOutcome {
            use crate::cli_bridge::daily::{period_append, DailyError};
            use myne_core::plugins::notes::daily_match::Period;

            let Some(period) = Period::from_wire(period) else {
                return DailyAppendOutcome::UnknownPeriod;
            };
            let Some(state) = self
                .app
                .try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()
            else {
                return DailyAppendOutcome::Io;
            };
            let Some(hooks) = self.app.try_state::<myne_core::hooks::Hooks>() else {
                return DailyAppendOutcome::Io;
            };
            // A live co-editing session owns its note; the CLI append must be
            // refused through the same registry the desktop manages.
            let Some(registry) = self
                .app
                .try_state::<myne_core::plugins::live::LiveSessionRegistry>()
            else {
                return DailyAppendOutcome::Io;
            };
            let host = myne_core::host::tauri_host::TauriHost::new(self.app.clone());
            let io = myne_core::vault_io::StdVaultIo;
            let result = tauri::async_runtime::block_on(period_append(
                &host,
                state.inner(),
                hooks.inner(),
                &io,
                registry.inner(),
                period,
                line,
            ));
            match result {
                Ok(used_device_clock) => {
                    self.notify_notes_changed();
                    DailyAppendOutcome::Ok(used_device_clock)
                }
                Err(DailyError::FolderExcluded) => DailyAppendOutcome::FolderExcluded,
                Err(DailyError::VaultLocked) => DailyAppendOutcome::VaultLocked,
                Err(DailyError::Io) => DailyAppendOutcome::Io,
            }
        }

        /// One external MCP connection's tool call (external-mcp-connection,
        /// myne-md/myne#923).
        ///
        /// Everything that decides is in `myne_core::plugins::mcp`: the grant
        /// read, the scope resolution and the four clamps all live there, and
        /// this function's whole job is to hand them the app's own state. The
        /// three `try_state` lookups are the only part the core cannot do —
        /// they are Tauri's registry — and a missing one is `Io` rather than a
        /// refusal, because a process that composed this door without those
        /// states is a wiring bug, not something a caller can act on.
        ///
        /// No new socket, no listener and no second lifecycle: this is called
        /// from the connection thread the CLI door already owns, after the
        /// shared limiter has already counted the request.
        fn mcp_call(&self, request: McpCallRequest) -> McpCallOutcome {
            use myne_core::plugins::mcp::host_adapters::door_call;
            use myne_core::plugins::mcp::tools::WireCall;
            use myne_core::plugins::vault_indices::VaultIndicesState;
            use myne_core::search::SearchIndexState;

            let Some(state) = self
                .app
                .try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()
            else {
                return McpCallOutcome::Io;
            };
            let Some(indices) = self.app.try_state::<VaultIndicesState>() else {
                return McpCallOutcome::Io;
            };
            let Some(search) = self.app.try_state::<SearchIndexState>() else {
                return McpCallOutcome::Io;
            };
            let Some(hooks) = self.app.try_state::<myne_core::hooks::Hooks>() else {
                return McpCallOutcome::Io;
            };
            let host = myne_core::host::tauri_host::TauriHost::new(self.app.clone());
            let io = myne_core::vault_io::StdVaultIo;
            tauri::async_runtime::block_on(door_call(
                &host,
                state.inner(),
                indices.inner(),
                search.inner(),
                hooks.inner(),
                &io,
                WireCall {
                    connection: &request.connection,
                    tool: &request.tool,
                    arguments: &request.arguments,
                },
            ))
        }
    }
}

#[cfg(unix)]
pub use app_seam::AppNoteLister;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct FixedLister {
        list: fn() -> ListOutcome,
        show: fn(&str) -> ShowOutcome,
        search: fn(&str) -> SearchOutcome,
        new_note: fn(&str, Option<&str>) -> NewOutcome,
        // myne#177: BOTH take the wire period spelling. Discarding it, as the
        // first version of this double did, makes a dispatcher that routes
        // every period to daily indistinguishable from a correct one.
        daily: fn(&str) -> DailyOutcome,
        daily_append: fn(&str, &str) -> DailyAppendOutcome,
        // myne-md/myne#788 (task 11). The path goes in; nothing comes back.
        open_file: fn(&str) -> OpenFileOutcome,
    }
    impl FixedLister {
        fn list_only(list: fn() -> ListOutcome) -> Self {
            Self {
                list,
                show: |_| ShowOutcome::Io,
                search: |_| SearchOutcome::Io,
                new_note: |_, _| NewOutcome::Io,
                daily: |_| DailyOutcome::Io,
                daily_append: |_, _| DailyAppendOutcome::Io,
                open_file: |_| OpenFileOutcome::Io,
            }
        }
        fn show_only(show: fn(&str) -> ShowOutcome) -> Self {
            Self {
                list: || ListOutcome::Io,
                show,
                search: |_| SearchOutcome::Io,
                new_note: |_, _| NewOutcome::Io,
                daily: |_| DailyOutcome::Io,
                daily_append: |_, _| DailyAppendOutcome::Io,
                open_file: |_| OpenFileOutcome::Io,
            }
        }
        fn search_only(search: fn(&str) -> SearchOutcome) -> Self {
            Self {
                list: || ListOutcome::Io,
                show: |_| ShowOutcome::Io,
                search,
                new_note: |_, _| NewOutcome::Io,
                daily: |_| DailyOutcome::Io,
                daily_append: |_, _| DailyAppendOutcome::Io,
                open_file: |_| OpenFileOutcome::Io,
            }
        }
        fn new_note_only(new_note: fn(&str, Option<&str>) -> NewOutcome) -> Self {
            Self {
                list: || ListOutcome::Io,
                show: |_| ShowOutcome::Io,
                search: |_| SearchOutcome::Io,
                new_note,
                daily: |_| DailyOutcome::Io,
                daily_append: |_, _| DailyAppendOutcome::Io,
                open_file: |_| OpenFileOutcome::Io,
            }
        }
        fn daily_only(daily: fn(&str) -> DailyOutcome) -> Self {
            Self {
                list: || ListOutcome::Io,
                show: |_| ShowOutcome::Io,
                search: |_| SearchOutcome::Io,
                new_note: |_, _| NewOutcome::Io,
                daily,
                daily_append: |_, _| DailyAppendOutcome::Io,
                open_file: |_| OpenFileOutcome::Io,
            }
        }
        fn daily_append_only(daily_append: fn(&str, &str) -> DailyAppendOutcome) -> Self {
            Self {
                list: || ListOutcome::Io,
                show: |_| ShowOutcome::Io,
                search: |_| SearchOutcome::Io,
                new_note: |_, _| NewOutcome::Io,
                daily: |_| DailyOutcome::Io,
                daily_append,
                open_file: |_| OpenFileOutcome::Io,
            }
        }
        fn open_only(open_file: fn(&str) -> OpenFileOutcome) -> Self {
            Self {
                list: || ListOutcome::Io,
                show: |_| ShowOutcome::Io,
                search: |_| SearchOutcome::Io,
                new_note: |_, _| NewOutcome::Io,
                daily: |_| DailyOutcome::Io,
                daily_append: |_, _| DailyAppendOutcome::Io,
                open_file,
            }
        }
    }
    impl NoteLister for FixedLister {
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
        // The parse/dispatch tests never send `mcp_call`; the command surface
        // gets its own double below (`McpSeam`), because a fixed-arm field here
        // would have to be threaded through eight constructors that do not care.
        fn mcp_call(&self, _request: McpCallRequest) -> McpCallOutcome {
            McpCallOutcome::Io
        }
    }

    /// The seam a `mcp_call` test dispatches through: it records what it was
    /// handed (so "the connection name and the arguments reached the seam
    /// verbatim" is assertable) and answers from a `fn` pointer.
    struct McpSeam {
        requests: std::sync::Mutex<Vec<McpCallRequest>>,
        outcome: Box<dyn Fn(&McpCallRequest) -> McpCallOutcome + Send + Sync>,
    }

    impl McpSeam {
        fn new(
            outcome: impl Fn(&McpCallRequest) -> McpCallOutcome + Send + Sync + 'static,
        ) -> Self {
            Self {
                requests: std::sync::Mutex::new(Vec::new()),
                outcome: Box::new(outcome),
            }
        }

        fn seen(&self) -> Vec<McpCallRequest> {
            self.requests.lock().expect("requests lock").clone()
        }
    }

    impl NoteLister for McpSeam {
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
        fn mcp_call(&self, request: McpCallRequest) -> McpCallOutcome {
            let outcome = (self.outcome)(&request);
            self.requests.lock().expect("requests lock").push(request);
            outcome
        }
    }

    fn framed(body: &[u8]) -> Vec<u8> {
        let mut v = (body.len() as u32).to_le_bytes().to_vec();
        v.extend_from_slice(body);
        v
    }

    /// A limiter that never throttles — every pre-task-10 test wants the
    /// dispatch behaviour, not the rate limit, so the cap is set beyond
    /// anything a single test issues.
    fn open_limiter() -> SharedRateLimiter {
        SharedRateLimiter::new(u32::MAX, std::time::Duration::from_secs(60))
    }

    fn roundtrip(request_json: &[u8], lister: &dyn NoteLister) -> serde_json::Value {
        roundtrip_limited(request_json, lister, &open_limiter())
    }

    fn roundtrip_limited(
        request_json: &[u8],
        lister: &dyn NoteLister,
        limiter: &SharedRateLimiter,
    ) -> serde_json::Value {
        let mut reader = Cursor::new(framed(request_json));
        let mut writer = Vec::new();
        serve_connection(&mut reader, &mut writer, lister, limiter, None);
        let reply_body =
            framing::read_frame_within(&mut Cursor::new(writer), None).expect("reply frame");
        serde_json::from_slice(&reply_body).expect("reply is valid JSON")
    }

    #[test]
    fn list_ok_returns_notes() {
        let lister = FixedLister::list_only(|| ListOutcome::Ok(vec!["a".into(), "b".into()]));
        let reply = roundtrip(br#"{"cmd":"list"}"#, &lister);
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["notes"], serde_json::json!(["a", "b"]));
    }

    #[test]
    fn list_vault_locked_maps_to_vault_locked_kind() {
        let lister = FixedLister::list_only(|| ListOutcome::VaultLocked);
        let reply = roundtrip(br#"{"cmd":"list"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "vault_locked");
    }

    #[test]
    fn list_io_failure_maps_to_io_kind() {
        let lister = FixedLister::list_only(|| ListOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"list"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "io");
    }

    #[test]
    fn malformed_json_maps_to_invalid_request_and_never_panics() {
        let lister = FixedLister::list_only(|| ListOutcome::Io);
        let reply = roundtrip(b"not json", &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");
    }

    #[test]
    fn unknown_cmd_maps_to_invalid_request() {
        let lister = FixedLister::list_only(|| ListOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"delete"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");
    }

    #[test]
    fn a_truncated_frame_never_panics_and_writes_no_reply() {
        // Declares 100 bytes, sends far fewer — `read_frame` returns
        // `Truncated`; `serve_connection` must return cleanly with no
        // reply written.
        let mut wire = (100u32).to_le_bytes().to_vec();
        wire.extend_from_slice(b"short");
        let mut reader = Cursor::new(wire);
        let mut writer = Vec::new();
        let lister = FixedLister::list_only(|| ListOutcome::Io);
        serve_connection(&mut reader, &mut writer, &lister, &open_limiter(), None);
        assert!(writer.is_empty(), "a truncated request must get no reply");
    }

    // ---- rate limit (task 10) ------------------------------------------

    #[test]
    fn an_over_budget_request_is_answered_with_the_rate_limited_kind() {
        let lister = FixedLister::list_only(|| ListOutcome::Ok(vec!["a".into()]));
        let limiter = SharedRateLimiter::new(1, std::time::Duration::from_secs(60));
        let first = roundtrip_limited(br#"{"cmd":"list"}"#, &lister, &limiter);
        assert_eq!(first["ok"], true, "the first request is within budget");
        let second = roundtrip_limited(br#"{"cmd":"list"}"#, &lister, &limiter);
        assert_eq!(second["ok"], false);
        assert_eq!(second["error"]["kind"], "rate_limited");
    }

    #[test]
    fn a_throttled_request_never_reaches_the_vault() {
        // The point of refusing early: an over-budget request must not
        // cost a whole-vault decrypt scan. The lister panics if touched.
        struct NeverCalled;
        impl NoteLister for NeverCalled {
            fn list_notes(&self) -> ListOutcome {
                panic!("a throttled request must never reach the vault");
            }
            fn show_note(&self, _id: &str) -> ShowOutcome {
                panic!("a throttled request must never reach the vault");
            }
            fn search_notes(&self, _query: &str) -> SearchOutcome {
                panic!("a throttled request must never reach the vault");
            }
            fn create_note(&self, _body: &str, _folder: Option<&str>) -> NewOutcome {
                panic!("a throttled request must never reach the vault");
            }
            fn period(&self, _period: &str) -> DailyOutcome {
                panic!("a throttled request must never reach the vault");
            }
            fn period_append(&self, _period: &str, _line: &str) -> DailyAppendOutcome {
                panic!("a throttled request must never reach the vault");
            }
            fn open_plain_file(&self, _path: &str) -> OpenFileOutcome {
                panic!("a throttled request must never reach the vault");
            }
            fn mcp_call(&self, _request: McpCallRequest) -> McpCallOutcome {
                panic!("a throttled request must never reach the vault");
            }
        }
        let limiter = SharedRateLimiter::new(0, std::time::Duration::from_secs(60));
        for request in [
            &br#"{"cmd":"list"}"#[..],
            br#"{"cmd":"show","id":"x"}"#,
            br#"{"cmd":"search","query":"x"}"#,
            br#"{"cmd":"new","body":"x"}"#,
            br#"{"cmd":"daily"}"#,
            br#"{"cmd":"daily_append","line":"x"}"#,
            br#"{"cmd":"open","path":"/tmp/x.md"}"#,
            br#"{"cmd":"mcp_call","connection":"c","tool":"note_search","arguments":{"query":"x"}}"#,
        ] {
            let reply = roundtrip_limited(request, &NeverCalled, &limiter);
            assert_eq!(reply["error"]["kind"], "rate_limited");
        }
    }

    #[test]
    fn a_throttled_reply_carries_no_field_beyond_the_error() {
        let lister = FixedLister::list_only(|| ListOutcome::Io);
        let limiter = SharedRateLimiter::new(0, std::time::Duration::from_secs(60));
        let reply = roundtrip_limited(br#"{"cmd":"list"}"#, &lister, &limiter);
        let obj = reply.as_object().expect("reply is an object");
        assert_eq!(obj.len(), 2, "exactly ok + error, no retry-after oracle");
        let message = reply["error"]["message"].as_str().unwrap().to_lowercase();
        // Copy discipline: the wire message is user-visible via `--json`,
        // so the same rule the CLI's own copy is tested against applies.
        for forbidden in ["protect", "security", "secure", "guard", "attack"] {
            assert!(
                !message.contains(forbidden),
                "rate-limit wire copy must not use {forbidden:?}: {message:?}"
            );
        }
    }

    #[test]
    fn removing_the_limit_is_observable_at_the_dispatch_layer() {
        // Task 10's "takes effect without restarting the app": the
        // supervisor flips this same flag on its next tick, and the very
        // next request over the SAME limiter is served.
        let lister = FixedLister::list_only(|| ListOutcome::Ok(vec![]));
        let limiter = SharedRateLimiter::new(0, std::time::Duration::from_secs(60));
        let refused = roundtrip_limited(br#"{"cmd":"list"}"#, &lister, &limiter);
        assert_eq!(refused["error"]["kind"], "rate_limited");
        limiter.set_disabled(true);
        let served = roundtrip_limited(br#"{"cmd":"list"}"#, &lister, &limiter);
        assert_eq!(served["ok"], true);
    }

    #[test]
    fn a_malformed_frame_does_not_consume_budget() {
        // A burst of undecodable frames must not eat a working caller's
        // window — the limiter sits after `read_frame`, before dispatch.
        let lister = FixedLister::list_only(|| ListOutcome::Ok(vec!["a".into()]));
        let limiter = SharedRateLimiter::new(1, std::time::Duration::from_secs(60));
        for _ in 0..10 {
            let mut wire = (100u32).to_le_bytes().to_vec();
            wire.extend_from_slice(b"short");
            let mut reader = Cursor::new(wire);
            let mut writer = Vec::new();
            serve_connection(&mut reader, &mut writer, &lister, &limiter, None);
            assert!(writer.is_empty());
        }
        let reply = roundtrip_limited(br#"{"cmd":"list"}"#, &lister, &limiter);
        assert_eq!(reply["ok"], true, "the one budgeted request survives");
    }

    #[test]
    fn show_ok_returns_body() {
        let lister = FixedLister::show_only(|_| ShowOutcome::Ok("hello world".to_string()));
        let reply = roundtrip(br#"{"cmd":"show","id":"x"}"#, &lister);
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["body"], "hello world");
    }

    #[test]
    fn show_not_found_maps_to_not_found_kind() {
        let lister = FixedLister::show_only(|_| ShowOutcome::NotFound);
        let reply = roundtrip(br#"{"cmd":"show","id":"bogus"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "not_found");
    }

    #[test]
    fn show_passes_the_requested_id_through_to_the_lister() {
        let lister = FixedLister::show_only(|id| {
            if id == "wanted" {
                ShowOutcome::Ok("matched".to_string())
            } else {
                ShowOutcome::NotFound
            }
        });
        let reply = roundtrip(br#"{"cmd":"show","id":"wanted"}"#, &lister);
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["body"], "matched");
    }

    #[test]
    fn show_vault_locked_maps_to_vault_locked_kind() {
        let lister = FixedLister::show_only(|_| ShowOutcome::VaultLocked);
        let reply = roundtrip(br#"{"cmd":"show","id":"x"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "vault_locked");
    }

    #[test]
    fn show_io_failure_maps_to_io_kind() {
        let lister = FixedLister::show_only(|_| ShowOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"show","id":"x"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "io");
    }

    #[test]
    fn show_missing_id_field_maps_to_invalid_request() {
        let lister = FixedLister::show_only(|_| ShowOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"show"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");
    }

    #[test]
    fn search_ok_returns_results() {
        let lister = FixedLister::search_only(|_| {
            SearchOutcome::Ok(vec![SearchHitWire {
                id: "a".into(),
                title: "Note A".into(),
            }])
        });
        let reply = roundtrip(br#"{"cmd":"search","query":"a"}"#, &lister);
        assert_eq!(reply["ok"], true);
        assert_eq!(
            reply["results"],
            serde_json::json!([{"id": "a", "title": "Note A"}])
        );
    }

    #[test]
    fn search_empty_results_carries_no_other_field() {
        // The oracle discipline (task 7): an empty result set — whether a
        // genuine no-match or an excluded hit — must be the ENTIRE reply
        // beyond `ok`/`results`. No count, no flag.
        let lister = FixedLister::search_only(|_| SearchOutcome::Ok(vec![]));
        let reply = roundtrip(br#"{"cmd":"search","query":"anything"}"#, &lister);
        assert_eq!(
            reply,
            serde_json::json!({ "ok": true, "results": [] }),
            "an empty search reply must carry nothing beyond ok/results"
        );
    }

    #[test]
    fn search_passes_the_query_through_to_the_lister() {
        let lister = FixedLister::search_only(|query| {
            if query == "wanted" {
                SearchOutcome::Ok(vec![SearchHitWire {
                    id: "x".into(),
                    title: "X".into(),
                }])
            } else {
                SearchOutcome::Ok(vec![])
            }
        });
        let reply = roundtrip(br#"{"cmd":"search","query":"wanted"}"#, &lister);
        assert_eq!(
            reply["results"],
            serde_json::json!([{"id": "x", "title": "X"}])
        );
    }

    #[test]
    fn search_vault_locked_maps_to_vault_locked_kind() {
        let lister = FixedLister::search_only(|_| SearchOutcome::VaultLocked);
        let reply = roundtrip(br#"{"cmd":"search","query":"x"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "vault_locked");
    }

    #[test]
    fn search_io_failure_maps_to_io_kind() {
        let lister = FixedLister::search_only(|_| SearchOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"search","query":"x"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "io");
    }

    #[test]
    fn search_missing_query_field_maps_to_invalid_request() {
        let lister = FixedLister::search_only(|_| SearchOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"search"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");
    }

    #[test]
    fn new_ok_returns_the_new_note_id() {
        let lister =
            FixedLister::new_note_only(|_, _| NewOutcome::Ok("01970e83-4f2f-7000-8000-x".into()));
        let reply = roundtrip(br#"{"cmd":"new","body":"hello"}"#, &lister);
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["id"], "01970e83-4f2f-7000-8000-x");
    }

    #[test]
    fn new_folder_excluded_maps_to_folder_excluded_kind() {
        let lister = FixedLister::new_note_only(|_, _| NewOutcome::FolderExcluded);
        let reply = roundtrip(
            br#"{"cmd":"new","body":"hello","folder":"Private/"}"#,
            &lister,
        );
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "folder_excluded");
    }

    #[test]
    fn new_invalid_folder_maps_to_invalid_request_kind() {
        let lister = FixedLister::new_note_only(|_, _| NewOutcome::InvalidFolder);
        let reply = roundtrip(
            br#"{"cmd":"new","body":"hello","folder":"Private\nx"}"#,
            &lister,
        );
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");
    }

    #[test]
    fn new_vault_locked_maps_to_vault_locked_kind() {
        let lister = FixedLister::new_note_only(|_, _| NewOutcome::VaultLocked);
        let reply = roundtrip(br#"{"cmd":"new","body":"hello"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "vault_locked");
    }

    #[test]
    fn new_io_failure_maps_to_io_kind() {
        let lister = FixedLister::new_note_only(|_, _| NewOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"new","body":"hello"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "io");
    }

    #[test]
    fn new_missing_body_field_maps_to_invalid_request() {
        let lister = FixedLister::new_note_only(|_, _| NewOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"new"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");
    }

    #[test]
    fn new_passes_the_body_and_folder_through_to_the_lister() {
        let lister = FixedLister::new_note_only(|body, folder| {
            if body == "wanted body" && folder == Some("Work/") {
                NewOutcome::Ok("matched".to_string())
            } else {
                NewOutcome::Io
            }
        });
        let reply = roundtrip(
            br#"{"cmd":"new","body":"wanted body","folder":"Work/"}"#,
            &lister,
        );
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["id"], "matched");
    }

    #[test]
    fn new_with_no_folder_field_passes_none_through() {
        let lister = FixedLister::new_note_only(|_, folder| {
            if folder.is_none() {
                NewOutcome::Ok("root".to_string())
            } else {
                NewOutcome::Io
            }
        });
        let reply = roundtrip(br#"{"cmd":"new","body":"hello"}"#, &lister);
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["id"], "root");
    }

    #[test]
    fn daily_ok_returns_body() {
        let lister =
            FixedLister::daily_only(|_| DailyOutcome::Ok("today's body".to_string(), false));
        let reply = roundtrip(br#"{"cmd":"daily"}"#, &lister);
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["body"], "today's body");
    }

    #[test]
    fn daily_folder_excluded_maps_to_folder_excluded_kind() {
        let lister = FixedLister::daily_only(|_| DailyOutcome::FolderExcluded);
        let reply = roundtrip(br#"{"cmd":"daily"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "folder_excluded");
    }

    #[test]
    fn daily_vault_locked_maps_to_vault_locked_kind() {
        let lister = FixedLister::daily_only(|_| DailyOutcome::VaultLocked);
        let reply = roundtrip(br#"{"cmd":"daily"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "vault_locked");
    }

    #[test]
    fn daily_io_failure_maps_to_io_kind() {
        let lister = FixedLister::daily_only(|_| DailyOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"daily"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "io");
    }

    #[test]
    fn daily_append_ok_returns_bare_ok_with_no_extra_field() {
        let lister = FixedLister::daily_append_only(|_, _| DailyAppendOutcome::Ok(false));
        let reply = roundtrip(br#"{"cmd":"daily_append","line":"hello"}"#, &lister);
        assert_eq!(
            reply,
            serde_json::json!({ "ok": true }),
            "success carries nothing beyond ok"
        );
    }

    #[test]
    fn daily_append_folder_excluded_maps_to_folder_excluded_kind() {
        let lister = FixedLister::daily_append_only(|_, _| DailyAppendOutcome::FolderExcluded);
        let reply = roundtrip(br#"{"cmd":"daily_append","line":"x"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "folder_excluded");
    }

    #[test]
    fn daily_append_vault_locked_maps_to_vault_locked_kind() {
        let lister = FixedLister::daily_append_only(|_, _| DailyAppendOutcome::VaultLocked);
        let reply = roundtrip(br#"{"cmd":"daily_append","line":"x"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "vault_locked");
    }

    #[test]
    fn daily_append_io_failure_maps_to_io_kind() {
        let lister = FixedLister::daily_append_only(|_, _| DailyAppendOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"daily_append","line":"x"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "io");
    }

    #[test]
    fn daily_append_missing_line_field_maps_to_invalid_request() {
        let lister = FixedLister::daily_append_only(|_, _| DailyAppendOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"daily_append"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");
    }

    // myne#177. The `period` / `period_append` wire shapes, and the two legacy
    // spellings whose only remaining job is to arrive as the daily period. Each
    // case reads what the SEAM was handed, not what the reply said, because a
    // dispatcher that answered every request with the daily note would satisfy
    // an assertion on the reply alone.

    /// Reports back the period spelling it was handed, so a case can read it
    /// out of the reply body without a shared mutable cell.
    fn echoing_period() -> FixedLister {
        FixedLister::daily_only(|period| DailyOutcome::Ok(period.to_string(), false))
    }

    #[test]
    fn period_hands_the_wire_spelling_to_the_seam_verbatim() {
        for wire in ["daily", "weekly", "monthly"] {
            let frame = format!(r#"{{"cmd":"period","period":"{wire}"}}"#);
            let reply = roundtrip(frame.as_bytes(), &echoing_period());
            assert_eq!(reply["ok"], true);
            assert_eq!(reply["body"], wire, "the seam saw a different period");
        }
    }

    #[test]
    fn an_unknown_period_reaches_the_seam_rather_than_the_dispatcher_guessing() {
        // The refusal is the vault-side lister's, not this layer's: a period
        // this host does not know is version skew, and answering it with the
        // daily note would be the one wrong answer. So the dispatcher passes it
        // through unchanged and lets the seam refuse.
        let reply = roundtrip(
            br#"{"cmd":"period","period":"quarterly"}"#,
            &echoing_period(),
        );
        assert_eq!(reply["body"], "quarterly");
    }

    #[test]
    fn the_legacy_daily_request_arrives_as_the_daily_period() {
        let reply = roundtrip(br#"{"cmd":"daily"}"#, &echoing_period());
        assert_eq!(reply["body"], "daily");
    }

    #[test]
    fn period_missing_the_period_field_maps_to_invalid_request() {
        let lister = FixedLister::daily_only(|_| DailyOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"period"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");
    }

    #[test]
    fn period_carries_the_device_clock_flag_and_omits_it_otherwise() {
        // A FLAG, not a sentence: the CLI owns the wording, so the reply cannot
        // carry host-supplied bytes onto the CLI's stderr. Omitted when false,
        // so a reply to a client predating the field is unchanged.
        let on = FixedLister::daily_only(|_| DailyOutcome::Ok("b".to_string(), true));
        let reply = roundtrip(br#"{"cmd":"period","period":"weekly"}"#, &on);
        assert_eq!(reply["body"], "b");
        assert_eq!(reply["used_device_clock"], true);

        let off = FixedLister::daily_only(|_| DailyOutcome::Ok("b".to_string(), false));
        let reply = roundtrip(br#"{"cmd":"period","period":"weekly"}"#, &off);
        assert_eq!(
            reply,
            serde_json::json!({ "ok": true, "body": "b" }),
            "the flag must be absent, not false"
        );
    }

    #[test]
    fn period_append_carries_the_device_clock_flag_and_omits_it_otherwise() {
        let on = FixedLister::daily_append_only(|_, _| DailyAppendOutcome::Ok(true));
        let reply = roundtrip(
            br#"{"cmd":"period_append","period":"weekly","line":"x"}"#,
            &on,
        );
        assert_eq!(reply["used_device_clock"], true);

        let off = FixedLister::daily_append_only(|_, _| DailyAppendOutcome::Ok(false));
        let reply = roundtrip(
            br#"{"cmd":"period_append","period":"weekly","line":"x"}"#,
            &off,
        );
        assert_eq!(
            reply,
            serde_json::json!({ "ok": true }),
            "the flag must be absent, not false"
        );
    }

    #[test]
    fn period_error_kinds_are_the_same_map_the_daily_arm_uses() {
        fn assert_kind(outcome: fn(&str) -> DailyOutcome, kind: &str) {
            let lister = FixedLister::daily_only(outcome);
            let reply = roundtrip(br#"{"cmd":"period","period":"monthly"}"#, &lister);
            assert_eq!(reply["ok"], false);
            assert_eq!(reply["error"]["kind"], kind);
        }
        assert_kind(|_| DailyOutcome::FolderExcluded, "folder_excluded");
        assert_kind(|_| DailyOutcome::VaultLocked, "vault_locked");
        assert_kind(|_| DailyOutcome::Io, "io");
        // Version skew reads as version skew, not as a failing disk.
        assert_kind(|_| DailyOutcome::UnknownPeriod, "invalid_request");
    }

    // An append reply carries no string, so the double reports the period it was
    // handed by ACCEPTING one spelling and refusing every other. A `fn` pointer
    // cannot capture the spelling it is looking for, so there is one item per
    // period rather than a loop.
    fn only_daily(period: &str, line: &str) -> DailyAppendOutcome {
        accept_if(period == "daily", line)
    }
    fn only_weekly(period: &str, line: &str) -> DailyAppendOutcome {
        accept_if(period == "weekly", line)
    }
    fn only_monthly(period: &str, line: &str) -> DailyAppendOutcome {
        accept_if(period == "monthly", line)
    }
    fn accept_if(period_matched: bool, line: &str) -> DailyAppendOutcome {
        if period_matched && line == "wanted line" {
            DailyAppendOutcome::Ok(false)
        } else {
            DailyAppendOutcome::Io
        }
    }

    #[test]
    fn period_append_hands_both_the_period_and_the_line_to_the_seam() {
        for (wire, only) in [
            ("daily", only_daily as fn(&str, &str) -> DailyAppendOutcome),
            ("weekly", only_weekly),
            ("monthly", only_monthly),
        ] {
            let frame =
                format!(r#"{{"cmd":"period_append","period":"{wire}","line":"wanted line"}}"#);
            let reply = roundtrip(frame.as_bytes(), &FixedLister::daily_append_only(only));
            assert_eq!(
                reply["ok"], true,
                "the seam saw a different period, or the line did not arrive intact"
            );
        }
    }

    #[test]
    fn the_legacy_daily_append_request_arrives_as_the_daily_period() {
        let reply = roundtrip(
            br#"{"cmd":"daily_append","line":"wanted line"}"#,
            &FixedLister::daily_append_only(only_daily),
        );
        assert_eq!(reply["ok"], true);
    }

    #[test]
    fn period_append_missing_the_period_field_maps_to_invalid_request() {
        let lister = FixedLister::daily_append_only(|_, _| DailyAppendOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"period_append","line":"x"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");
    }

    #[test]
    fn period_append_missing_the_line_field_maps_to_invalid_request() {
        let lister = FixedLister::daily_append_only(|_, _| DailyAppendOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"period_append","period":"weekly"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");
    }

    // ---- myne-md/myne#788 task 11: `myne open` ---------------------------

    #[test]
    fn open_ok_replies_with_a_bare_ok() {
        let lister = FixedLister::open_only(|_| OpenFileOutcome::Ok);
        let reply = roundtrip(br#"{"cmd":"open","path":"/tmp/note.md"}"#, &lister);
        assert_eq!(reply, serde_json::json!({ "ok": true }));
    }

    #[test]
    fn open_hands_the_path_to_the_seam_verbatim() {
        // The one field this command exists to carry. If it were dropped, a
        // reply of `ok` would look identical while nothing ever opened.
        let lister = FixedLister::open_only(|path| {
            if path == "/tmp/wanted.md" {
                OpenFileOutcome::Ok
            } else {
                OpenFileOutcome::NotFound
            }
        });
        let reply = roundtrip(br#"{"cmd":"open","path":"/tmp/wanted.md"}"#, &lister);
        assert_eq!(reply["ok"], true);
    }

    #[test]
    fn open_gate_off_maps_to_the_plain_file_off_kind() {
        let lister = FixedLister::open_only(|_| OpenFileOutcome::PlainFileOff);
        let reply = roundtrip(br#"{"cmd":"open","path":"/tmp/note.md"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "plain_file_off");
    }

    #[test]
    fn open_unsupported_extension_maps_to_unsupported_file() {
        let lister = FixedLister::open_only(|_| OpenFileOutcome::UnsupportedFile);
        let reply = roundtrip(br#"{"cmd":"open","path":"/tmp/note.txt"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "unsupported_file");
    }

    #[test]
    fn open_missing_path_maps_to_not_found() {
        let lister = FixedLister::open_only(|_| OpenFileOutcome::NotFound);
        let reply = roundtrip(br#"{"cmd":"open","path":"/tmp/gone.md"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "not_found");
    }

    #[test]
    fn open_too_large_maps_to_the_too_large_kind() {
        let lister = FixedLister::open_only(|_| OpenFileOutcome::TooLarge);
        let reply = roundtrip(br#"{"cmd":"open","path":"/tmp/huge.md"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "too_large");
    }

    #[test]
    fn open_io_failure_maps_to_io_kind() {
        let lister = FixedLister::open_only(|_| OpenFileOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"open","path":"/tmp/note.md"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "io");
    }

    #[test]
    fn open_missing_the_path_field_maps_to_invalid_request() {
        let lister = FixedLister::open_only(|_| OpenFileOutcome::Io);
        let reply = roundtrip(br#"{"cmd":"open"}"#, &lister);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");
    }

    // ---- external-mcp-connection (myne-md/myne#923): `mcp_call` ----------

    use myne_core::plugins::mcp::error::McpToolError;

    /// What the seam is handed for one wire frame. Read out of the double rather
    /// than inferred from the reply, because a reply of `ok` looks identical
    /// whether the connection name arrived or was dropped.
    fn mcp_request(frame: &[u8]) -> McpCallRequest {
        let seam = McpSeam::new(|_| McpCallOutcome::Result(serde_json::json!({ "content": [] })));
        let _ = roundtrip(frame, &seam);
        seam.seen()
            .pop()
            .expect("the mcp_call request must reach the seam")
    }

    fn ok_result(_request: &McpCallRequest) -> McpCallOutcome {
        McpCallOutcome::Result(serde_json::json!({
            "content": [{ "type": "text", "text": "one row" }],
            "structuredContent": [{ "noteId": "a" }],
            "isError": false,
        }))
    }

    #[test]
    fn a_successful_mcp_call_relays_the_whole_call_tool_result() {
        let seam = McpSeam::new(ok_result);
        let reply = roundtrip(
            br#"{"cmd":"mcp_call","connection":"claude-desktop","tool":"note_search","arguments":{"query":"a"}}"#,
            &seam,
        );
        assert_eq!(reply["ok"], true);
        // The shim's `tool_success` forwards `result` only when it carries a
        // `content` array, so this is the field a client actually reads.
        assert_eq!(reply["result"]["content"][0]["text"], "one row");
        assert_eq!(reply["result"]["structuredContent"][0]["noteId"], "a");
        assert_eq!(reply["result"]["isError"], false);
        // And nothing of the door's own vocabulary leaks into it: no `error`,
        // no `notes`, no `body`.
        let object = reply.as_object().expect("reply is an object");
        assert_eq!(object.len(), 2, "exactly ok + result: {reply}");
    }

    #[test]
    fn mcp_call_hands_the_connection_name_tool_and_arguments_through_verbatim() {
        // The connection name is the KEY to a grant. A seam that received a
        // blank, a lower-cased or a truncated name would look up a different
        // grant than the one the user approved, so it is asserted as bytes.
        let request = mcp_request(
            br#"{"cmd":"mcp_call","connection":"Claude Desktop","tool":"note_read","arguments":{"note_id":"0192abcd","nested":{"k":[1,2]}}}"#,
        );
        assert_eq!(request.connection, "Claude Desktop");
        assert_eq!(request.tool, "note_read");
        assert_eq!(
            request.arguments,
            serde_json::json!({ "note_id": "0192abcd", "nested": { "k": [1, 2] } }),
            "the arguments must arrive untouched, scope fields and all: the host \
             refuses one it does not know rather than editing it"
        );
    }

    #[test]
    fn a_refused_mcp_call_carries_its_reason_as_the_wire_kind_and_its_sentence_as_the_message() {
        // The shim relays `kind` into `structuredContent.reason` and `message`
        // into the text block, so the two halves are the whole refusal a human
        // ends up reading. Each refusal is asserted against the host's own
        // closed vocabulary rather than against a string written here.
        for error in [
            McpToolError::NoGrant,
            McpToolError::EmptyQuery,
            McpToolError::OutOfScopeNote {
                note_id: "a".into(),
            },
            McpToolError::OutOfScopeFolder {
                folder: "Private/".into(),
            },
            McpToolError::VaultUnavailable,
        ] {
            let expected_kind = error.reason();
            let expected_message = error.message();
            let seam = McpSeam::new(move |_| McpCallOutcome::Refused(error.clone()));
            let reply = roundtrip(
                br#"{"cmd":"mcp_call","connection":"c","tool":"note_search","arguments":{"query":"a"}}"#,
                &seam,
            );
            assert_eq!(reply["ok"], false);
            assert_eq!(
                reply["error"]["kind"], expected_kind,
                "the wire kind and the reason must be one label"
            );
            assert_eq!(reply["error"]["message"], expected_message);
        }
    }

    #[test]
    fn an_unimplemented_mcp_verb_is_answered_as_version_skew() {
        // `invalid_request`, not a scope refusal: the five write verbs the
        // compiled catalog offers are tasks 13 to 16, and a client newer than
        // its host must be able to tell skew from "you may not write there".
        let seam = McpSeam::new(|_| McpCallOutcome::UnknownTool);
        let reply = roundtrip(
            br#"{"cmd":"mcp_call","connection":"c","tool":"note_create","arguments":{}}"#,
            &seam,
        );
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");
        assert!(
            reply["error"]["message"]
                .as_str()
                .is_some_and(|m| m.contains("tool")),
            "the message must name what was not known: {reply}"
        );
    }

    #[test]
    fn malformed_mcp_call_answers_invalid_request() {
        for frame in [
            // No `connection`: the shim always sends one, so a frame without it
            // did not come from the shim.
            &br#"{"cmd":"mcp_call","tool":"note_search","arguments":{"query":"a"}}"#[..],
            // No `tool` at all.
            br#"{"cmd":"mcp_call","connection":"c","arguments":{}}"#,
            // A non-string tool.
            br#"{"cmd":"mcp_call","connection":"c","tool":7,"arguments":{}}"#,
        ] {
            let seam = McpSeam::new(|_| McpCallOutcome::Result(serde_json::json!({})));
            let reply = roundtrip(frame, &seam);
            assert_eq!(reply["ok"], false, "accepted {frame:?}");
            assert_eq!(reply["error"]["kind"], "invalid_request");
        }

        // And the ARM's own malformed answer, which is what a decoded frame with
        // undecodable arguments produces (`deny_unknown_fields`, a wrong type,
        // a missing required field). Asserted through the seam's outcome so the
        // mapping is what is under test here; the decode itself is
        // `core::plugins::mcp::tools`'s, tested there.
        let seam = McpSeam::new(|_| McpCallOutcome::Malformed);
        let reply = roundtrip(
            br#"{"cmd":"mcp_call","connection":"c","tool":"note_search","arguments":{"scope":["Private/"]}}"#,
            &seam,
        );
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");
    }

    #[test]
    fn an_absent_arguments_field_reaches_the_seam_as_null_rather_than_as_an_empty_object() {
        // `{}` and "nothing at all" are different calls, and only the arm can
        // tell them apart: defaulting an absent field to `{}` would make a
        // truncated frame succeed against `vault_list`. The seam receives Null,
        // which its argument decode refuses.
        let request = mcp_request(br#"{"cmd":"mcp_call","connection":"c","tool":"vault_list"}"#);
        assert_eq!(request.arguments, serde_json::Value::Null);
    }

    #[test]
    fn an_mcp_call_while_locked_answers_vault_locked() {
        let seam = McpSeam::new(|_| McpCallOutcome::VaultLocked);
        let reply = roundtrip(
            br#"{"cmd":"mcp_call","connection":"c","tool":"vault_state","arguments":{}}"#,
            &seam,
        );
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "vault_locked");
    }

    #[test]
    fn an_mcp_call_io_failure_answers_the_io_kind() {
        let seam = McpSeam::new(|_| McpCallOutcome::Io);
        let reply = roundtrip(
            br#"{"cmd":"mcp_call","connection":"c","tool":"vault_state","arguments":{}}"#,
            &seam,
        );
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "io");
    }

    #[test]
    fn a_refused_mcp_call_still_costs_a_rate_limiter_token() {
        // The limiter gates the door, not the vault: it is checked BEFORE the
        // request is dispatched (see `serve_connection`), so a call the host
        // then refuses has already been counted. That is the property this test
        // exists for — if a refusal were free, a caller could probe lock state,
        // grant names and scope boundaries an unbounded number of times per
        // window while every answer was "no".
        //
        // The budget is one. The first call is refused for having no grant; if
        // that refusal had not consumed the token, the second request would be
        // SERVED and the assertion below would see `ok: true`.
        let seam = McpSeam::new(|_| McpCallOutcome::Refused(McpToolError::NoGrant));
        let limiter = SharedRateLimiter::new(1, std::time::Duration::from_secs(60));

        let refused = roundtrip_limited(
            br#"{"cmd":"mcp_call","connection":"unnamed-client","tool":"note_search","arguments":{"query":"a"}}"#,
            &seam,
            &limiter,
        );
        assert_eq!(refused["ok"], false);
        assert_eq!(refused["error"]["kind"], "no_grant");

        // The second request is over budget. It is a plain `list` so the
        // assertion cannot be satisfied by the mcp arm itself refusing again.
        let throttled = roundtrip_limited(br#"{"cmd":"list"}"#, &seam, &limiter);
        assert_eq!(
            throttled["error"]["kind"], "rate_limited",
            "a refused call must consume the token it was let through on: {throttled}"
        );
        assert_eq!(seam.seen().len(), 1, "only the first call reached the seam");
    }

    #[test]
    fn an_mcp_call_does_not_log_or_echo_a_connection_name_into_the_reply() {
        // The name is AS3-class user text and the refused reply is the only place
        // it may appear — and it does not appear even there: a refusal names the
        // reason, never the caller's own spelling of its name. This is a cheap
        // regression guard on `encode_err`'s static-string signature, which is
        // what makes it structurally true.
        let seam = McpSeam::new(|_| McpCallOutcome::Refused(McpToolError::NoGrant));
        let reply = roundtrip(
            br#"{"cmd":"mcp_call","connection":"my-private-notes-client","tool":"note_search","arguments":{"query":"a"}}"#,
            &seam,
        );
        let wire = reply.to_string();
        assert!(
            !wire.contains("my-private-notes-client"),
            "the refusal echoed the connection name: {wire}"
        );
    }
}
