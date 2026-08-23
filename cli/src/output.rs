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
//! `rate_limited` / `io`.

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

fn error_parts(err: &BackendError) -> (&'static str, String) {
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

    /// The oracle property, at the envelope layer: a query that hit ONLY an
    /// excluded note and a query with a genuine no-match both arrive here as
    /// an empty `hits` slice (the backend already collapsed them) — so their
    /// rendered envelopes must be byte-for-byte identical, not merely
    /// "both empty" by coincidence of this one call.
    #[test]
    fn excluded_hit_and_genuine_miss_render_byte_identical_envelopes() {
        let excluded_hit_result: Vec<SearchHit> = vec![]; // backend already filtered
        let genuine_miss_result: Vec<SearchHit> = vec![];
        assert_eq!(
            search_envelope_json(&excluded_hit_result),
            search_envelope_json(&genuine_miss_result)
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
}
