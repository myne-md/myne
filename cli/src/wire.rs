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
    Daily,
    DailyAppend {
        line: String,
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
    fn daily_request_encodes_to_the_documented_shape() {
        let json = serde_json::to_string(&Request::Daily).unwrap();
        assert_eq!(json, r#"{"cmd":"daily"}"#);
    }

    #[test]
    fn daily_append_request_encodes_to_the_documented_shape() {
        let json = serde_json::to_string(&Request::DailyAppend {
            line: "hello".to_string(),
        })
        .unwrap();
        assert_eq!(json, r#"{"cmd":"daily_append","line":"hello"}"#);
    }

    #[test]
    fn decodes_a_successful_daily_reply() {
        let reply: RawResponse =
            serde_json::from_str(r#"{"ok":true,"body":"today's markdown"}"#).unwrap();
        assert!(reply.ok);
        assert_eq!(reply.body, Some("today's markdown".to_string()));
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
}
