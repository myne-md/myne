//! CLI output: the stable `--json` envelope (PRD story 11 — "a scripter
//! wants a structured envelope with a stable shape") and the
//! human-readable rendering.
//!
//! The envelope's SHAPE is a promise to scripts, independent of the wire
//! protocol between this binary and the desktop (`wire.rs`) — Phase 2's
//! `CoreBackend` may not even use a socket, and this shape must still hold.
//! `{"ok": true, "notes": [...]}` on a `list` success, `{"ok": true, "body":
//! "..."}` on a `show` success, `{"ok": false, "error": {"kind": "...",
//! "message": "..."}}` on failure. `kind` is one of: `app_not_running` /
//! `vault_locked` / `cli_disabled` / `not_found` / `folder_excluded` /
//! `rate_limited` / `plain_file_off` / `io`.

use serde::Serialize;

use crate::backend::{BackendError, SearchHit};

/// The static advisory `search` prints on every invocation, regardless of
/// result — see [`print_search`]'s doc comment for why it must never vary
/// with the query or the result set.
const SEARCH_SCOPE_ADVISORY: &str =
    "Some notes may be excluded from search results (see Settings).";

/// `Default` is the "success, no payload" envelope: every builder below sets
/// only the ONE field its command carries and takes the rest from here, so a
/// future field is one line rather than six. `ok` defaults to `true` because
/// five of the six shapes are successes; [`error_envelope_json`] sets it
/// false explicitly, right where it fills `error`.
#[derive(Serialize)]
struct JsonEnvelope<'a> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<&'a [String]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    results: Option<Vec<JsonSearchHit<'a>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonErrorBody>,
}

/// The `--json` shape of one search hit — this crate's own serialization
/// wrapper, kept separate from [`SearchHit`] (the transport-agnostic
/// `MyneBackend` return type) the same way `BackendError` stays unserialized
/// and `error_parts` builds its own JSON fields below.
#[derive(Serialize)]
struct JsonSearchHit<'a> {
    id: &'a str,
    title: &'a str,
}

#[derive(Serialize)]
struct JsonErrorBody {
    kind: &'static str,
    message: String,
}

impl Default for JsonEnvelope<'_> {
    fn default() -> Self {
        JsonEnvelope {
            ok: true,
            notes: None,
            body: None,
            results: None,
            id: None,
            error: None,
        }
    }
}

fn encode(envelope: JsonEnvelope) -> String {
    serde_json::to_string(&envelope).expect("envelope shape always encodes")
}

fn list_envelope_json(notes: &[String]) -> String {
    encode(JsonEnvelope {
        notes: Some(notes),
        ..JsonEnvelope::default()
    })
}

fn show_envelope_json(body: &str) -> String {
    encode(JsonEnvelope {
        body: Some(body),
        ..JsonEnvelope::default()
    })
}

/// **No field beyond `results` may ever be added here.** A count, a
/// "something was hidden" flag, anything at all beyond the array itself,
/// would be exactly the oracle [`print_search`] exists to close off.
fn search_envelope_json(hits: &[SearchHit]) -> String {
    encode(JsonEnvelope {
        results: Some(
            hits.iter()
                .map(|h| JsonSearchHit {
                    id: &h.id,
                    title: &h.title,
                })
                .collect(),
        ),
        ..JsonEnvelope::default()
    })
}

fn ok_envelope_json() -> String {
    encode(JsonEnvelope::default())
}

fn new_envelope_json(id: &str) -> String {
    encode(JsonEnvelope {
        id: Some(id),
        ..JsonEnvelope::default()
    })
}

fn error_envelope_json(err: &BackendError) -> String {
    let (kind, message) = error_parts(err);
    encode(JsonEnvelope {
        ok: false,
        error: Some(JsonErrorBody { kind, message }),
        ..JsonEnvelope::default()
    })
}

/// Render a successful `list` result — one note id per line in human mode
/// (the `ls` this feature exists to restore), or the stable envelope under
/// `--json`. An empty list prints nothing, matching `ls` on an empty
/// directory.
pub fn print_list(notes: &[String], json: bool) {
    if json {
        println!("{}", list_envelope_json(notes));
    } else {
        for id in notes {
            println!("{id}");
        }
    }
}

/// Render a successful `show` result — the note's markdown verbatim to
/// stdout in human mode (no decoration, no trailing chrome, pipe-clean — the
/// `cat` this feature exists to restore), or wrapped in the stable envelope
/// under `--json`. Explicitly flushes stdout before returning: unlike
/// `print_list`'s always-newline-terminated lines, a note body may not end
/// in `\n`, and `Stdout`'s internal `LineWriter` only auto-flushes on one —
/// without this, `std::process::exit` right after can drop buffered bytes.
pub fn print_show(body: &str, json: bool) {
    if json {
        println!("{}", show_envelope_json(body));
    } else {
        print!("{body}");
    }
    use std::io::Write;
    let _ = std::io::stdout().flush();
}

/// Render a successful `search` result — one `<id>\t<title>` line per hit in
/// human mode, or the stable envelope under `--json` (the `rg` this feature
/// exists to restore).
///
/// **Security-critical, not cosmetic** (task 7's own text — "the single
/// defect this feature is most exposed on"): an out-of-scope match is
/// omitted from `hits` entirely by the backend, and this function must
/// never re-introduce a signal that one was hidden. The advisory line below
/// is fixed text, identical on every call — it does not vary with `hits`,
/// the query, or whether anything was actually filtered — so a caller
/// cannot turn it into a count by comparing two invocations. It always goes
/// to stderr, both in human and `--json` mode, so stdout (or the `--json`
/// payload itself) never carries it and a script piping stdout is never
/// touched by it.
pub fn print_search(hits: &[SearchHit], json: bool) {
    if json {
        println!("{}", search_envelope_json(hits));
    } else {
        for hit in hits {
            println!("{}\t{}", hit.id, hit.title);
        }
    }
    eprintln!("{SEARCH_SCOPE_ADVISORY}");
}

/// Render a successful `new` result — the new note's id, so a script can
/// pipe it straight into `myne show`/`myne search` (the same "one useful
/// line" shape `git commit` prints its new hash in). Human mode prints the
/// bare id; `--json` wraps it in the stable envelope.
pub fn print_new(id: &str, json: bool) {
    if json {
        println!("{}", new_envelope_json(id));
    } else {
        println!("{id}");
    }
}

/// Render a successful `daily:append` result — silent in human mode
/// (matching the `>>` mental model this command restores: appending to a
/// file prints nothing), or the bare `{"ok":true}` envelope under `--json`.
pub fn print_daily_append(json: bool) {
    if json {
        println!("{}", ok_envelope_json());
    }
}

/// Render a successful `open` result (myne-md/myne#788): silent in human
/// mode, because the tab appearing in the app IS the feedback and the one
/// thing worth saying (the path) is not something this channel prints: a
/// filesystem path on the content channel is exactly the trace this feature
/// exists without. `--json` gets the bare `{"ok":true}` envelope.
pub fn print_open(json: bool) {
    if json {
        println!("{}", ok_envelope_json());
    }
}

/// The advisory a period command prints when the host resolved the period on
/// the device clock while a display-timezone override was set (myne#177).
///
/// It lives HERE rather than arriving on the wire, and that is the point: the
/// crate's `logging_discipline` allowlist rests on every value an `eprintln!`
/// interpolates being produced inside this crate, and it reads names rather
/// than values, so a host-supplied string would have carried a folder path or
/// an `io::Error` past it unnoticed. The host sends a bool; the wording is
/// ours.
///
/// It deliberately does not name the zone: an IANA identifier is a coarse
/// geolocation datum, which is why `protocol.md` §9.5 classes `timezone`
/// device-local so it never merges from a peer, and stderr is the channel that
/// ends up in `2>` redirects, CI logs and pasted output. The user set the
/// override, so naming it back adds nothing they do not know.
///
/// **THE RESIDUAL, and it is accepted rather than absent.** The line is
/// conditional, so its presence in a `2>` capture says "this vault has a
/// `timezone` override set". That is one bit, it is the existence of a setting
/// rather than its value, and it is strictly weaker than the identifier the
/// paragraph above refuses. The alternative that removes it is printing
/// unconditionally, since "this command used the device clock" is true of every
/// period command whether or not an override exists, and that trade was
/// declined: it turns a line that explains a genuinely confusing outcome (the
/// desktop shows Monday, `myne weekly` opens Sunday's note) into permanent
/// noise for every user who set no override, which is nearly all of them, and a
/// warning that always fires is a warning nobody reads. Deciding whether the
/// two zones actually DIFFER today, which would be the precise condition, needs
/// the zone database `decisions/storage/0556` argues down, so it is not
/// available at any price this design pays.
///
/// It already prints at most once per invocation: one command, one call, and
/// nothing loops over periods.
const DEVICE_CLOCK_NOTE: &str =
    "note: this command used the device clock; the display timezone override is not applied to periodic-notes commands";

/// Print [`DEVICE_CLOCK_NOTE`] to STDERR when the host used the device clock.
///
/// stderr rather than stdout, in both human and `--json` mode, and that is the
/// load-bearing half: `myne weekly > this-week.md` is the obvious use, and a
/// warning written into that file would corrupt the thing it was warning
/// about. Under `--json` it would also make the output stop being JSON.
pub fn print_device_clock_note(used_device_clock: bool) {
    if used_device_clock {
        eprintln!("{DEVICE_CLOCK_NOTE}");
    }
}

/// Render a failure. Human mode writes to stderr so a failed `--json`-less
/// invocation never corrupts stdout a caller might still be piping.
pub fn print_error(err: &BackendError, json: bool) {
    if json {
        println!("{}", error_envelope_json(err));
    } else {
        let (_, message) = error_parts(err);
        eprintln!("myne: {message}");
    }
}

/// `pub(crate)` so the backend tests can assert the envelope KIND a failure
/// emits (myne-md/myne#788): the `open` remap is only correct if a script sees
/// `io` for a missing file, and asserting the `BackendError` variant alone
/// would let the output table drift underneath it.
pub(crate) fn error_parts(err: &BackendError) -> (&'static str, String) {
    match err {
        BackendError::AppNotRunning => (
            "app_not_running",
            "Myne is not running. Start the app first.".to_string(),
        ),
        BackendError::VaultLocked => (
            "vault_locked",
            "Myne is locked. Unlock it in the app first.".to_string(),
        ),
        BackendError::CliDisabled => (
            "cli_disabled",
            "CLI access is off. Enable it in Myne's Settings.".to_string(),
        ),
        BackendError::NotFound => ("not_found", "No matching note.".to_string()),
        BackendError::FolderExcluded => (
            "folder_excluded",
            "That folder is excluded from CLI access. Nothing was written.".to_string(),
        ),
        // Copy discipline (task 10): this describes a pace, and offers the
        // switch that removes it. It must never call the limit a
        // protection, or its removal the disabling of one — the door has
        // no gatekeeper for a limit to stand in for
        // (`docs/threat-model.md` §7). `no_copy_calls_the_rate_limit_a_
        // protection` below is the machine-checked half of this rule.
        BackendError::RateLimited => (
            "rate_limited",
            "Too many requests in a short time. Wait a moment and try again, \
             or turn the CLI rate limit off in Myne's Settings."
                .to_string(),
        ),
        BackendError::PlainFileOff => (
            "plain_file_off",
            "Local-file editing is off. Enable it in Myne's Settings.".to_string(),
        ),
        BackendError::Io(message) => ("io", message.clone()),
    }
}

/// Test seam for the crate-wide audit in [`crate::logging_discipline`]: the
/// human-readable half of [`error_parts`], which is otherwise private to this
/// module's own rendering.
#[cfg(test)]
pub fn message_for(err: &BackendError) -> String {
    error_parts(err).1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_envelope_shape_is_pinned() {
        assert_eq!(
            list_envelope_json(&["a".to_string(), "b".to_string()]),
            r#"{"ok":true,"notes":["a","b"]}"#
        );
    }

    #[test]
    fn empty_list_envelope_still_carries_notes_field() {
        // `--json` output shape must be stable whether or not there are
        // results — a script should never need to special-case "no notes".
        assert_eq!(list_envelope_json(&[]), r#"{"ok":true,"notes":[]}"#);
    }

    #[test]
    fn show_envelope_shape_is_pinned() {
        assert_eq!(
            show_envelope_json("hello\nworld"),
            r#"{"ok":true,"body":"hello\nworld"}"#
        );
    }

    #[test]
    fn search_envelope_shape_is_pinned() {
        assert_eq!(
            search_envelope_json(&[SearchHit {
                id: "a".to_string(),
                title: "Note A".to_string()
            }]),
            r#"{"ok":true,"results":[{"id":"a","title":"Note A"}]}"#
        );
    }

    #[test]
    fn empty_search_envelope_carries_no_field_beyond_ok_and_results() {
        // The oracle discipline (task 7): an empty `results` array — whether
        // a genuine no-match or an excluded hit — must be the entire reply.
        let json = search_envelope_json(&[]);
        assert_eq!(json, r#"{"ok":true,"results":[]}"#);
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            value.as_object().unwrap().len(),
            2,
            "must carry exactly ok + results, nothing else"
        );
    }

    #[test]
    fn error_envelope_shape_is_pinned() {
        assert_eq!(
            error_envelope_json(&BackendError::VaultLocked),
            r#"{"ok":false,"error":{"kind":"vault_locked","message":"Myne is locked. Unlock it in the app first."}}"#
        );
    }

    #[test]
    fn error_kind_labels_match_the_documented_envelope_vocabulary() {
        for err in [
            BackendError::AppNotRunning,
            BackendError::VaultLocked,
            BackendError::CliDisabled,
            BackendError::NotFound,
            BackendError::FolderExcluded,
            BackendError::RateLimited,
            BackendError::PlainFileOff,
            BackendError::Io("x".into()),
        ] {
            let (kind, _) = error_parts(&err);
            assert!([
                "app_not_running",
                "vault_locked",
                "cli_disabled",
                "not_found",
                "folder_excluded",
                "rate_limited",
                "plain_file_off",
                "io"
            ]
            .contains(&kind));
        }
    }

    #[test]
    fn rate_limited_error_envelope_shape_is_pinned() {
        assert_eq!(
            error_envelope_json(&BackendError::RateLimited),
            r#"{"ok":false,"error":{"kind":"rate_limited","message":"Too many requests in a short time. Wait a moment and try again, or turn the CLI rate limit off in Myne's Settings."}}"#
        );
    }

    /// Task 10's copy criterion, machine-checked: "No copy anywhere
    /// describes the limit as a protection or its removal as disabling
    /// one." The rate limit bounds a pace; the door it sits on has no
    /// identity gatekeeper (`docs/threat-model.md` §7), so language that
    /// implies one is a claim in the wrong direction — the failure this
    /// test exists to catch is a well-meaning copy edit, not a bug.
    #[test]
    fn no_copy_calls_the_rate_limit_a_protection() {
        let (_, message) = error_parts(&BackendError::RateLimited);
        let lowered = message.to_lowercase();
        for forbidden in [
            "protect", "security", "secure", "safety", "safe", "guard", "block", "attack", "unsafe",
        ] {
            assert!(
                !lowered.contains(forbidden),
                "rate-limit copy must not use {forbidden:?}: {message:?}"
            );
        }
    }

    #[test]
    fn ok_envelope_shape_is_pinned() {
        assert_eq!(ok_envelope_json(), r#"{"ok":true}"#);
    }

    #[test]
    fn new_envelope_shape_is_pinned() {
        assert_eq!(
            new_envelope_json("abc-123"),
            r#"{"ok":true,"id":"abc-123"}"#
        );
    }

    #[test]
    fn folder_excluded_error_envelope_shape_is_pinned() {
        assert_eq!(
            error_envelope_json(&BackendError::FolderExcluded),
            r#"{"ok":false,"error":{"kind":"folder_excluded","message":"That folder is excluded from CLI access. Nothing was written."}}"#
        );
    }

    #[test]
    fn plain_file_off_error_envelope_shape_is_pinned() {
        assert_eq!(
            error_envelope_json(&BackendError::PlainFileOff),
            r#"{"ok":false,"error":{"kind":"plain_file_off","message":"Local-file editing is off. Enable it in Myne's Settings."}}"#
        );
    }
}
