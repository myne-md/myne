// SPDX-License-Identifier: AGPL-3.0
//! One `tools/call` on its way to the door: who is calling, and what travels.
//!
//! The envelope is the whole reason this is a module rather than three lines in
//! `server.rs`. Two things about it are load-bearing and both are invisible in a
//! call site:
//!
//! ## The connection name
//!
//! The host resolves a scope by the name the client declares, so the name is the
//! key to a grant rather than a credential (`docs/threat-model.md` TB15's
//! "a label, not a credential"). It comes from two places, in this order:
//!
//! 1. `MYNE_MCP_CONNECTION`, the env var the Settings snippet writes into the
//!    client's config. This wins because it is the name the USER approved: a
//!    client that ships its own `clientInfo.name` cannot rename itself into (or
//!    out of) a grant, and the snippet is what makes the key stable across
//!    reconnects.
//! 2. `clientInfo.name` from an `initialize` handshake, for a client configured
//!    by hand. The stateless revision has no handshake, so a stateless client
//!    that is not configured with the env var arrives as
//!    [`UNNAMED_CONNECTION`] and is refused for having no grant, which is the
//!    correct outcome: a connection nobody named was never approved.
//!
//! The name is **trimmed and otherwise sent as given**. It is not lower-cased
//! and not NFC-normalized: the host normalizes on WRITE, so the spelling that
//! matches a grant is the one the Settings snippet carries, and rewording it here
//! would mean the shim and the app disagree about which name a grant is under.
//! A name that does not match a grant is refused, which is exactly what an
//! unapproved name should be.
//!
//! ## What the request may not contain
//!
//! No scope, no note ids, no folder list: those are resolved host-side from the
//! stored grant. The request carries the tool name, the caller's arguments
//! verbatim, and the connection name — nothing this process decided about the
//! vault, because this process knows nothing about the vault.

use serde_json::{json, Value};

use crate::errors;
use crate::transport::{DoorAnswer, Transport};

/// The door command a tool call travels as. The host's dispatcher answers the
/// same name; the per-tool payload shape is that side's contract.
pub const DOOR_TOOL_CALL_CMD: &str = "mcp_call";

/// The env var a client's config carries the approved connection name in.
pub const CONNECTION_ENV: &str = "MYNE_MCP_CONNECTION";

/// The name sent when neither source names the connection.
///
/// Deliberately a name no approval can produce by accident (it contains a
/// hyphen, which the Settings UI's own name validation can also permit, so it is
/// written here once and nowhere else): the call is refused for having no grant,
/// and `no_grant` is the honest answer for a client nobody approved.
pub const UNNAMED_CONNECTION: &str = "unnamed-client";

/// The name this call travels under: the configured one, else the handshake's.
///
/// Pure, and takes both sources as parameters rather than reading the
/// environment, so the precedence is testable without a process-global.
pub fn resolve(configured: Option<&str>, declared: Option<&str>) -> String {
    [configured, declared]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|name| !name.is_empty())
        .unwrap_or(UNNAMED_CONNECTION)
        .to_string()
}

/// The door request for one tool call.
pub fn door_request(tool: &str, arguments: Value, connection: &str) -> Value {
    json!({
        "cmd": DOOR_TOOL_CALL_CMD,
        "tool": tool,
        "arguments": arguments,
        "connection": connection,
    })
}

/// Forward one validated call to the door and turn its answer into a
/// `tools/call` result.
///
/// Three outcomes, all of them results rather than protocol errors: the door is
/// closed (a [`crate::errors::Refusal`]), the door answered (relayed verbatim if
/// it looks like a `CallToolResult`), or the door refused the call (relayed with
/// its own `kind` and text). `server.rs` owns the validation that decides whether
/// a call gets this far.
pub fn execute(transport: &Transport, tool: &str, arguments: Value, connection: &str) -> Value {
    let request = door_request(tool, arguments, connection);
    match transport.call(&request) {
        Err(refusal) => refusal.result(),
        Ok(DoorAnswer::Ok { result }) => errors::tool_success(result),
        Ok(DoorAnswer::Refused { kind, message }) => errors::door_refusal(&kind, &message),
    }
}
