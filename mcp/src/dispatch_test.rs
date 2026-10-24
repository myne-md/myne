// SPDX-License-Identifier: AGPL-3.0
//! The envelope one tool call travels in: which name it carries, and what it may
//! not carry.
//!
//! The session-level half (the handshake's `clientInfo.name` reaching a real
//! door) lives in `transport_test.rs` beside the fake door it needs; everything
//! here is pure.

use serde_json::json;

use crate::dispatch::{
    door_request, resolve, CONNECTION_ENV, DOOR_TOOL_CALL_CMD, UNNAMED_CONNECTION,
};

#[test]
fn the_configured_name_wins_and_the_handshake_name_is_the_fallback() {
    // The env var is the name the USER approved (the Settings snippet writes it
    // into the client's config); `clientInfo.name` is the client's own idea of
    // itself, which it must not be able to use to enter a grant the user did not
    // attach to it.
    assert_eq!(
        resolve(Some("claude-desktop"), Some("Claude")),
        "claude-desktop"
    );
    assert_eq!(resolve(None, Some("Claude")), "Claude");
    assert_eq!(resolve(None, None), UNNAMED_CONNECTION);
    assert_eq!(resolve(Some("  "), Some("Claude")), "Claude");
    assert_eq!(resolve(Some("  "), Some("\t\n")), UNNAMED_CONNECTION);
}

#[test]
fn a_name_is_trimmed_but_never_rewritten() {
    // Case and inner spacing are the user's: the host normalizes on WRITE, so the
    // spelling that matches a grant is the one the snippet carries. Re-casing or
    // folding here would make the shim and the app disagree about which name a
    // grant is filed under.
    assert_eq!(resolve(Some("  My Laptop  "), None), "My Laptop");
    assert_eq!(resolve(Some("CLAUDE-Desktop"), None), "CLAUDE-Desktop");
}

#[test]
fn the_env_var_name_is_the_one_the_snippet_uses() {
    // The literal is duplicated into the Settings snippet and the user guide;
    // spelled here so a rename is a failing test rather than a silent no-match.
    assert_eq!(CONNECTION_ENV, "MYNE_MCP_CONNECTION");
}

#[test]
fn the_request_is_a_command_a_tool_its_arguments_and_a_name() {
    let request = door_request("note_search", json!({ "query": "x" }), "claude-desktop");
    assert_eq!(request["cmd"], DOOR_TOOL_CALL_CMD);
    assert_eq!(request["tool"], "note_search");
    assert_eq!(request["arguments"]["query"], "x");
    assert_eq!(request["connection"], "claude-desktop");

    // Four keys, and no fifth. A `scope`, a `folders` or a `note_ids` here would
    // be this process deciding something about the vault, which it knows nothing
    // about: the scope is resolved host-side from the stored grant.
    let keys: Vec<&String> = request.as_object().expect("an object").keys().collect();
    assert_eq!(keys, vec!["arguments", "cmd", "connection", "tool"]);
}

#[test]
fn an_empty_argument_map_is_sent_rather_than_omitted() {
    // The host reads `arguments` as an object; a missing key would make a
    // zero-argument tool (`vault_list`) indistinguishable from a malformed call.
    let request = door_request("vault_list", json!({}), "claude-desktop");
    assert_eq!(request["arguments"], json!({}));
}
