// SPDX-License-Identifier: AGPL-3.0
//! JSON-RPC 2.0 on the wire, and the two MCP revisions this binary speaks.
//!
//! The two revision strings are a **wire contract**, not a Myne identifier: no
//! vault, blob or tag depends on them. They are pinned here because a client
//! compares them literally, and a typo reads to that client as "server is
//! broken" rather than as a version mismatch.
//!
//! The older revision opens a session with `initialize` and keeps protocol
//! state for the life of the connection. The current revision is stateless:
//! each request carries what it needs, and there is no handshake to open one.
//! Both are served from one dispatcher ([`crate::server::Server`]) because this
//! surface uses nothing either revision changed: no server-initiated requests,
//! no subscriptions, no progress notifications.

use serde_json::{json, Value};

/// The stateful revision: `initialize` → `notifications/initialized` → requests.
pub const STATEFUL_REVISION: &str = "2025-11-25";

/// The stateless revision: a request is self-contained, and there is no
/// handshake to send first.
pub const STATELESS_REVISION: &str = "2026-07-28";

/// JSON-RPC 2.0's reserved codes, the three this server can produce. The
/// application-level refusals (`vault_locked`, `door_disabled`,
/// `app_not_running`) are tool results rather than protocol errors, and belong
/// to the task that adds `tools/call`.
pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;

/// Which revision this session speaks. Selected exactly once, by the first
/// frame, and then fixed: a client that changes its mind mid-session is not a
/// case the protocol offers, and re-selecting would make the session's
/// behaviour depend on a frame that arrived later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Revision {
    Stateful,
    Stateless,
}

impl Revision {
    /// The value this session reports as `protocolVersion`.
    pub fn protocol_version(self) -> &'static str {
        match self {
            Revision::Stateful => STATEFUL_REVISION,
            Revision::Stateless => STATELESS_REVISION,
        }
    }

    /// A bounded label for diagnostics. Never carries client data.
    pub fn label(self) -> &'static str {
        match self {
            Revision::Stateful => "stateful",
            Revision::Stateless => "stateless",
        }
    }
}

/// The sniff: an `initialize` **request** as the first frame means a client
/// that expects the stateful handshake; anything else means a client that
/// simply sends a request, which is the current revision's shape.
///
/// This is a check on the frame's shape, not on its contents: a frame carrying
/// `initialize` as a *notification* selects the stateless path, because a
/// notification can never open a stateful session (the client would be waiting
/// for a response that never comes).
pub fn revision_for_first_frame(frame: &Value) -> Revision {
    match frame.get("method").and_then(Value::as_str) {
        Some("initialize") if frame.get("id").is_some() => Revision::Stateful,
        _ => Revision::Stateless,
    }
}

/// One inbound frame, after the JSON-RPC envelope has been checked.
#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    /// A request: it always gets exactly one response.
    Request { id: Value, method: String },
    /// A notification: it never gets a response, whatever its method.
    Notification,
}

/// A frame that is not a well-formed JSON-RPC 2.0 message at all.
#[derive(Debug, PartialEq, Eq)]
pub struct RpcError {
    pub code: i64,
    pub message: &'static str,
}

const INVALID: RpcError = RpcError {
    code: INVALID_REQUEST,
    message: "Invalid Request",
};

/// Check the envelope and split request from notification.
///
/// `params` is deliberately not carried: this slice answers `tools/list` from a
/// constant and `initialize` without reading the client's capabilities, so
/// keeping the value around would be a field nobody reads. The task that adds
/// `tools/call` extends this enum rather than re-parsing the frame.
pub fn classify(frame: Value) -> Result<Incoming, RpcError> {
    let Some(object) = frame.as_object() else {
        return Err(INVALID);
    };
    // `"2.0"` is not a version number to negotiate; it is the only value the
    // envelope has ever had, and a frame without it is not a JSON-RPC message.
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(INVALID);
    }
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return Err(INVALID);
    };
    if method.is_empty() {
        return Err(INVALID);
    }
    let method = method.to_owned();
    match object.get("id") {
        Some(id) => Ok(Incoming::Request {
            id: id.clone(),
            method,
        }),
        // The absent-`id` shape is how JSON-RPC says "notification". MCP's own
        // `notifications/initialized` and `notifications/cancelled` arrive
        // this way, and so does anything a future client invents.
        None => Ok(Incoming::Notification),
    }
}

/// A successful response.
pub fn response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// An error response. The message is always a static string: nothing a client
/// sent is echoed back, so no unbounded or attacker-chosen text reaches the
/// stream.
pub fn error_response(id: Value, code: i64, message: &'static str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}
