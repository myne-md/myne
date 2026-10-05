//! The wire contract with the desktop's CLI bridge command socket
//! (`src-tauri/src/cli_bridge/dispatch.rs`). This is this crate's own copy
//! of that shape — deliberately not a shared type (see that module's doc
//! comment: a wire *contract*, not shared Rust code) — so this binary never
//! depends on `myne-desktop`.
//!
//! Request: `{"cmd": "<name>", ...}`. Response: `{"ok": true, ...}` or
//! `{"ok": false, "error": {"kind": "...", "message": "..."}}`.

use serde::{Deserialize, Serialize};

/// A request to the desktop's command socket — `List`, `Show`, `Search`,
/// `New` (tasks 4, 6, 7, 8) and `Daily`/`DailyAppend` (task 9).
#[derive(Debug, Serialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    List,
    Show {
        id: String,
    },
    Search {
        query: String,
    },
    New {
        body: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        folder: Option<String>,
    },
    /// myne#177. A distinct command NAME rather than an optional field on
    /// `daily`, so a host that predates periodic notes answers "unknown
    /// command" instead of silently returning the daily note for a `weekly`
    /// request. `period` is the wire spelling: `daily` / `weekly` / `monthly`.
    ///
    /// This crate no longer emits the older `daily` / `daily_append` shapes:
    /// `myne daily` goes out as `period` with `"daily"`, so the timezone
    /// advisory reaches the command where a one-day mismatch bites hardest.
    /// The HOST still accepts the old shapes, for a `myne` binary older than
    /// the app it is talking to.
    Period {
        period: String,
    },
    PeriodAppend {
        period: String,
        line: String,
    },
    /// myne-md/myne#788 (plaintext-file-editor task 11). Opens a local
    /// markdown file in the running app's plain-file surface. The path is
    /// re-validated desktop-side (gate, extension, size) before anything is
    /// read; this crate never opens the file.
    Open {
        path: String,
    },
}

/// The `error` object of a failure reply.
#[derive(Debug, Deserialize)]
pub struct WireError {
    pub kind: String,
    pub message: String,
}

/// One `search` hit: an id + its title, nothing else — matches the
/// desktop's own `SearchHitWire` (`src-tauri/src/cli_bridge/dispatch.rs`),
/// this crate's independent copy of that wire shape.
#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct WireSearchHit {
    pub id: String,
    pub title: String,
}

/// The decoded reply, generic over the wire shape — every command's
/// success fields are optional here (`#[serde(default)]`) since only one
/// of `ok: true` / `ok: false` branch's fields is ever populated.
#[derive(Debug, Deserialize)]
pub struct RawResponse {
    pub ok: bool,
    #[serde(default)]
    pub notes: Option<Vec<String>>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub results: Option<Vec<WireSearchHit>>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub error: Option<WireError>,
    /// myne#177. Present and `true` only when a display-timezone override is
    /// set that the host does NOT apply to period resolution, so the user can
    /// see why the app and the CLI might disagree about which note is
    /// "today's". A FLAG rather than the host's sentence, deliberately: this
    /// crate's `logging_discipline` allowlist rests on every value written to
    /// stderr being produced HERE, and it checks names rather than values, so a
    /// host-supplied string would have slipped a folder path or an `io::Error`
    /// past it. `#[serde(default)]`, so a reply from a host
    /// that predates the field decodes unchanged.
    #[serde(default)]
    pub used_device_clock: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_request_encodes_to_the_documented_shape() {
        let json = serde_json::to_string(&Request::List).unwrap();
        assert_eq!(json, r#"{"cmd":"list"}"#);
    }

    #[test]
    fn show_request_encodes_to_the_documented_shape() {
        let json = serde_json::to_string(&Request::Show {
            id: "abc".to_string(),
        })
        .unwrap();
        assert_eq!(json, r#"{"cmd":"show","id":"abc"}"#);
    }

    #[test]
    fn decodes_a_successful_list_reply() {
        let reply: RawResponse = serde_json::from_str(r#"{"ok":true,"notes":["a","b"]}"#).unwrap();
        assert!(reply.ok);
        assert_eq!(reply.notes, Some(vec!["a".to_string(), "b".to_string()]));
        assert!(reply.body.is_none());
        assert!(reply.error.is_none());
    }

    #[test]
    fn decodes_a_successful_show_reply() {
        let reply: RawResponse = serde_json::from_str(r#"{"ok":true,"body":"hello"}"#).unwrap();
        assert!(reply.ok);
        assert_eq!(reply.body, Some("hello".to_string()));
        assert!(reply.notes.is_none());
        assert!(reply.error.is_none());
    }

    #[test]
    fn decodes_an_error_reply() {
        let reply: RawResponse =
            serde_json::from_str(r#"{"ok":false,"error":{"kind":"vault_locked","message":"x"}}"#)
                .unwrap();
        assert!(!reply.ok);
        assert_eq!(reply.error.unwrap().kind, "vault_locked");
    }

    #[test]
    fn search_request_encodes_to_the_documented_shape() {
        let json = serde_json::to_string(&Request::Search {
            query: "hello".to_string(),
        })
        .unwrap();
        assert_eq!(json, r#"{"cmd":"search","query":"hello"}"#);
    }

    #[test]
    fn decodes_a_successful_search_reply() {
        let reply: RawResponse =
            serde_json::from_str(r#"{"ok":true,"results":[{"id":"a","title":"Note A"}]}"#).unwrap();
        assert!(reply.ok);
        assert_eq!(
            reply.results,
            Some(vec![WireSearchHit {
                id: "a".to_string(),
                title: "Note A".to_string()
            }])
        );
        assert!(reply.notes.is_none());
        assert!(reply.body.is_none());
        assert!(reply.error.is_none());
    }

    #[test]
    fn decodes_an_empty_successful_search_reply() {
        let reply: RawResponse = serde_json::from_str(r#"{"ok":true,"results":[]}"#).unwrap();
        assert!(reply.ok);
        assert_eq!(reply.results, Some(vec![]));
    }

    #[test]
    fn new_request_with_no_folder_omits_the_folder_field() {
        let json = serde_json::to_string(&Request::New {
            body: "hello".to_string(),
            folder: None,
        })
        .unwrap();
        assert_eq!(json, r#"{"cmd":"new","body":"hello"}"#);
    }

    #[test]
    fn new_request_with_a_folder_encodes_to_the_documented_shape() {
        let json = serde_json::to_string(&Request::New {
            body: "hello".to_string(),
            folder: Some("Private/".to_string()),
        })
        .unwrap();
        assert_eq!(json, r#"{"cmd":"new","body":"hello","folder":"Private/"}"#);
    }

    #[test]
    fn decodes_a_successful_new_reply() {
        let reply: RawResponse = serde_json::from_str(r#"{"ok":true,"id":"abc"}"#).unwrap();
        assert!(reply.ok);
        assert_eq!(reply.id, Some("abc".to_string()));
        assert!(reply.notes.is_none());
        assert!(reply.body.is_none());
        assert!(reply.results.is_none());
        assert!(reply.error.is_none());
    }

    #[test]
    fn decodes_a_folder_excluded_error_reply() {
        let reply: RawResponse = serde_json::from_str(
            r#"{"ok":false,"error":{"kind":"folder_excluded","message":"x"}}"#,
        )
        .unwrap();
        assert!(!reply.ok);
        assert_eq!(reply.error.unwrap().kind, "folder_excluded");
    }

    #[test]
    fn decodes_a_rate_limited_error_reply() {
        let reply: RawResponse =
            serde_json::from_str(r#"{"ok":false,"error":{"kind":"rate_limited","message":"x"}}"#)
                .unwrap();
        assert!(!reply.ok);
        assert_eq!(reply.error.unwrap().kind, "rate_limited");
    }

    #[test]
    fn daily_goes_out_as_a_period_request() {
        // myne#177: this crate no longer emits `{"cmd":"daily"}`. Routing every
        // period through one command is what carries the timezone advisory to
        // `myne daily`, and the host still ACCEPTS the old shape for a `myne`
        // binary older than the app (pinned host-side, in
        // `src-tauri/src/cli_bridge/dispatch.rs`).
        let json = serde_json::to_string(&Request::Period {
            period: "daily".to_string(),
        })
        .unwrap();
        assert_eq!(json, r#"{"cmd":"period","period":"daily"}"#);
    }

    #[test]
    fn daily_append_goes_out_as_a_period_append_request() {
        let json = serde_json::to_string(&Request::PeriodAppend {
            period: "daily".to_string(),
            line: "hello".to_string(),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"cmd":"period_append","period":"daily","line":"hello"}"#
        );
    }

    #[test]
    fn decodes_a_successful_daily_reply() {
        let reply: RawResponse =
            serde_json::from_str(r#"{"ok":true,"body":"today's markdown"}"#).unwrap();
        assert!(reply.ok);
        assert_eq!(reply.body, Some("today's markdown".to_string()));
    }

    #[test]
    fn period_request_encodes_to_the_documented_shape() {
        let json = serde_json::to_string(&Request::Period {
            period: "weekly".to_string(),
        })
        .unwrap();
        assert_eq!(json, r#"{"cmd":"period","period":"weekly"}"#);
    }

    #[test]
    fn period_append_request_encodes_to_the_documented_shape() {
        let json = serde_json::to_string(&Request::PeriodAppend {
            period: "monthly".to_string(),
            line: "hello".to_string(),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"cmd":"period_append","period":"monthly","line":"hello"}"#
        );
    }

    #[test]
    fn decodes_a_reply_carrying_the_device_clock_flag() {
        let raw = r#"{"ok":true,"body":"Week 35","used_device_clock":true}"#;
        let decoded: RawResponse = serde_json::from_str(raw).unwrap();
        assert!(decoded.ok);
        assert_eq!(decoded.body.as_deref(), Some("Week 35"));
        assert!(decoded.used_device_clock);
    }

    #[test]
    fn decodes_a_reply_without_the_device_clock_flag() {
        // The older-host direction: the field is additive, so a reply that
        // never carried it must still decode rather than failing the command.
        let raw = r#"{"ok":true,"body":"Week 35"}"#;
        let decoded: RawResponse = serde_json::from_str(raw).unwrap();
        assert!(decoded.ok);
        assert!(!decoded.used_device_clock);
    }

    #[test]
    fn decodes_a_bare_ok_daily_append_reply() {
        let reply: RawResponse = serde_json::from_str(r#"{"ok":true}"#).unwrap();
        assert!(reply.ok);
        assert!(reply.body.is_none());
        assert!(reply.id.is_none());
        assert!(reply.notes.is_none());
        assert!(reply.results.is_none());
        assert!(reply.error.is_none());
    }

    #[test]
    fn open_request_encodes_to_the_documented_shape() {
        let json = serde_json::to_string(&Request::Open {
            path: "/tmp/note.md".to_string(),
        })
        .unwrap();
        assert_eq!(json, r#"{"cmd":"open","path":"/tmp/note.md"}"#);
    }

    #[test]
    fn decodes_a_plain_file_off_error_reply() {
        let reply: RawResponse =
            serde_json::from_str(r#"{"ok":false,"error":{"kind":"plain_file_off","message":"x"}}"#)
                .unwrap();
        assert!(!reply.ok);
        assert_eq!(reply.error.unwrap().kind, "plain_file_off");
    }
}
