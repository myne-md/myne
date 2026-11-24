// SPDX-License-Identifier: AGPL-3.0-only
//! The dispatcher: one inbound line in, at most one outbound message out.
//!
//! It is a pure function of `(frame, session revision)` and one IO edge, the
//! [`Transport`]. That split is what lets both revision paths, the locked case
//! and the three-state refusal taxonomy be tested against a fake door over a
//! real socket, with no vault and no app.
//!
//! `tools/list` and `server/discover` both answer from [`crate::tools::catalog`],
//! a compiled-in constant, so discovery does not depend on the vault being
//! unlocked, on external access being enabled, or on Myne running at all. They
//! read the SAME function rather than two copies of the list, because a client
//! that discovers by one method and calls by the other must not see two
//! different surfaces.
//!
//! ## What `tools/call` is allowed to do here
//!
//! It forwards, and it answers for a closed door. It does not enforce scope, does
//! not know what a folder is, and does not decide what a verb means: those live
//! host-side, behind the same door the CLI uses, so that one implementation is
//! the authority for both front-ends. What this file owns is request validation
//! and the refusal a caller gets when there is no door to ask, because a shim
//! that answered a closed door with a protocol error would read to a client as a
//! broken server and the session would be re-established rather than resumed.
//! The envelope and the connection name live in [`crate::dispatch`].

use serde_json::{json, Value};

use crate::dispatch;
use crate::errors;
use crate::protocol::{self, Incoming, Revision};
use crate::tools;
use crate::transport::Transport;

/// Reported as `serverInfo.name`. A client shows this, so it is the product
/// name rather than the binary name.
pub const SERVER_NAME: &str = "myne-mcp";

/// One MCP session. The state is the revision the first frame selected and the
/// name the client declared, both of which are fixed by the first frame that
/// carries them.
#[derive(Debug, Default)]
pub struct Server {
    revision: Option<Revision>,
    transport: Transport,
    /// `MYNE_MCP_CONNECTION`, read once: a process cannot change its own config
    /// mid-session, and reading it per call would let a test's environment leak
    /// into an unrelated assertion.
    configured_name: Option<String>,
    /// `clientInfo.name` from the handshake, when the client sent one.
    declared_name: Option<String>,
}

impl Server {
    /// A session over an explicit door client. Production uses [`Default`]; a
    /// test passes a [`Transport`] bound to a temp app-data dir, and only
    /// `Transport::at` (itself test-gated) can point at anything else.
    pub fn with_transport(transport: Transport) -> Self {
        Self {
            revision: None,
            transport,
            configured_name: std::env::var(dispatch::CONNECTION_ENV).ok(),
            declared_name: None,
        }
    }

    /// A session with the connection name pinned, bypassing the environment.
    ///
    /// The test seam for the name, the same shape as `Transport::at`: a test that
    /// asserted the handshake name while `MYNE_MCP_CONNECTION` happened to be set
    /// in the developer's shell would pass or fail by environment, which is the
    /// flaky shape this avoids.
    #[cfg(test)]
    pub fn with_transport_named(transport: Transport, declared: Option<&str>) -> Self {
        Self {
            revision: None,
            transport,
            configured_name: None,
            declared_name: declared.map(str::to_string),
        }
    }

    /// The revision this session speaks, or `None` before the first frame.
    pub fn revision(&self) -> Option<Revision> {
        self.revision
    }

    /// The name this session's calls travel under.
    fn connection(&self) -> String {
        dispatch::resolve(
            self.configured_name.as_deref(),
            self.declared_name.as_deref(),
        )
    }

    /// Handle one newline-delimited frame.
    ///
    /// `None` means "say nothing", which is the correct answer to a
    /// notification and to a blank line. A malformed frame still gets a reply,
    /// because a JSON-RPC peer is entitled to be told its frame did not parse.
    pub fn handle(&mut self, frame: &str) -> Option<Value> {
        let parsed: Value = match serde_json::from_str(frame) {
            Ok(parsed) => parsed,
            Err(_) => {
                return Some(protocol::error_response(
                    Value::Null,
                    protocol::PARSE_ERROR,
                    "Parse error",
                ))
            }
        };

        // The sniff happens on the raw frame, before the envelope check: the
        // revision is a property of what the client sent first, and a frame
        // that fails validation a moment later does not un-send it.
        let revision = *self
            .revision
            .get_or_insert_with(|| protocol::revision_for_first_frame(&parsed));

        match protocol::classify(parsed) {
            Ok(Incoming::Notification) => None,
            Ok(Incoming::Request { id, method, params }) => {
                Some(self.answer(id, &method, params.as_ref(), revision))
            }
            Err(error) => Some(protocol::error_response(
                Value::Null,
                error.code,
                error.message,
            )),
        }
    }

    fn answer(
        &mut self,
        id: Value,
        method: &str,
        params: Option<&Value>,
        revision: Revision,
    ) -> Value {
        match method {
            // Answered in BOTH revisions, deliberately. A stateless client
            // never needs it, and a client that probed with `tools/list` first
            // (the sniff's other branch) may still send it; refusing would
            // dead-end a client that is merely old-fashioned, and the cost of
            // answering is that `protocolVersion` becomes the observable proof
            // of which revision the first frame selected.
            "initialize" => {
                // The one piece of the handshake this session keeps. The FIRST
                // declared name wins: a second `initialize` cannot rename a
                // session into a different grant mid-stream.
                if self.declared_name.is_none() {
                    self.declared_name = params
                        .and_then(|params| params.get("clientInfo"))
                        .and_then(|info| info.get("name"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                protocol::response(id, self.handshake(revision))
            }
            // The stateless revision's discovery method. A strict client of that
            // revision asks ONLY this, so leaving it at `-32601` was a hole in
            // the revision rather than a missing nicety: the payload is the
            // handshake plus the tool list, so a client can skip the handshake
            // and still learn everything `tools/list` would have told it.
            "server/discover" => protocol::response(id, self.discovery(revision)),
            "ping" => protocol::response(id, json!({})),
            "tools/list" => protocol::response(id, json!({ "tools": tools::catalog() })),
            "tools/call" => self.tool_call(id, params),
            _ => protocol::error_response(id, protocol::METHOD_NOT_FOUND, "Method not found"),
        }
    }

    /// What `initialize` returns: which revision, what this server offers, who
    /// it is. Not the tool list, which the handshake leaves to `tools/list`.
    fn handshake(&self, revision: Revision) -> Value {
        json!({
            "protocolVersion": revision.protocol_version(),
            "capabilities": { "tools": {} },
            "serverInfo": server_info(),
        })
    }

    /// What `server/discover` returns: the handshake PLUS the tool list, from the
    /// same compiled catalog `tools/list` serves.
    fn discovery(&self, revision: Revision) -> Value {
        let mut payload = self.handshake(revision);
        payload["tools"] = json!(tools::catalog());
        payload
    }

    /// Validate one tool call, then forward it to the door through
    /// [`dispatch::execute`], or answer for a closed door.
    fn tool_call(&self, id: Value, params: Option<&Value>) -> Value {
        let Some(params) = params else {
            return protocol::error_response(id, protocol::INVALID_PARAMS, "Invalid params");
        };
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return protocol::error_response(id, protocol::INVALID_PARAMS, "Invalid params");
        };
        // An unknown verb is refused as a tool error rather than a protocol
        // error, so the caller is told what happened instead of seeing a broken
        // server. The exclusion classes the PRD names (delete, rename, whole-body
        // replace) arrive through this same arm, because they are verbs this
        // server does not offer, not verbs it partially honours.
        if !tools::offers(name) {
            return protocol::response(
                id,
                errors::local_refusal(
                    "unknown_tool",
                    "No tool by that name: call tools/list to see the tools this server offers, \
                     and call one of those. Nothing was changed.",
                ),
            );
        }
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !arguments.is_object() {
            return protocol::error_response(id, protocol::INVALID_PARAMS, "Invalid params");
        }

        let result = dispatch::execute(&self.transport, name, arguments, &self.connection());
        protocol::response(id, result)
    }
}

/// The `serverInfo` block, shared by every discovery answer.
fn server_info() -> Value {
    json!({
        "name": SERVER_NAME,
        "version": env!("CARGO_PKG_VERSION")
    })
}
