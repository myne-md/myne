// SPDX-License-Identifier: AGPL-3.0
//! The dispatcher: one inbound line in, at most one outbound message out.
//!
//! It is a pure function of `(frame, session revision)` with no IO, which is
//! what lets both revision paths and the locked-discovery case be tested
//! without a socket, a vault or a running app.
//!
//! `tools/list` answers from [`crate::tools::catalog`] — a compiled-in
//! constant — so discovery does not depend on the vault being unlocked, on
//! external access being enabled, or on Myne running at all. That is the whole
//! reason this slice can ship before any tool call does: a client's setup is
//! verifiable while the vault is closed.

use serde_json::{json, Value};

use crate::protocol::{self, Incoming, Revision};
use crate::tools;

/// Reported as `serverInfo.name`. A client shows this, so it is the product
/// name rather than the binary name.
pub const SERVER_NAME: &str = "myne-mcp";

/// One MCP session. The only state is the revision the first frame selected.
#[derive(Debug, Default)]
pub struct Server {
    revision: Option<Revision>,
}

impl Server {
    /// The revision this session speaks, or `None` before the first frame.
    pub fn revision(&self) -> Option<Revision> {
        self.revision
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
            Ok(Incoming::Request { id, method }) => Some(self.answer(id, &method, revision)),
            Err(error) => Some(protocol::error_response(
                Value::Null,
                error.code,
                error.message,
            )),
        }
    }

    fn answer(&self, id: Value, method: &str, revision: Revision) -> Value {
        match method {
            // Answered in BOTH revisions, deliberately. A stateless client
            // never needs it, and a client that probed with `tools/list` first
            // (the sniff's other branch) may still send it; refusing would
            // dead-end a client that is merely old-fashioned, and the cost of
            // answering is that `protocolVersion` becomes the observable proof
            // of which revision the first frame selected.
            "initialize" => protocol::response(
                id,
                json!({
                    "protocolVersion": revision.protocol_version(),
                    "capabilities": { "tools": {} },
                    "serverInfo": {
                        "name": SERVER_NAME,
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            ),
            "ping" => protocol::response(id, json!({})),
            "tools/list" => protocol::response(id, json!({ "tools": tools::catalog() })),
            // Deliberately NOT `tools/call`. Tool execution belongs to the task
            // that adds the door client and the refusal taxonomy; answering it
            // here with a guessed shape would be an invented contract the next
            // task has to keep or break.
            _ => protocol::error_response(id, protocol::METHOD_NOT_FOUND, "Method not found"),
        }
    }
}
