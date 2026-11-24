// SPDX-License-Identifier: AGPL-3.0-only
//! The refusal taxonomy, and the two MCP result shapes this binary emits.
//!
//! ## Why a refusal is a tool result and not a protocol error
//!
//! A JSON-RPC error for "the vault is locked" is valid and many clients read it
//! as a broken server and reconnect, which is the exact failure the lock-survival
//! requirement exists to avoid. So every state a caller can act on comes back as
//! a `tools/call` result with `isError: true`, carrying a machine-readable
//! `reason` and ONE actionable sentence. The sentence matters more than the
//! reason: the calling agent relays it to a human verbatim, and "vault is
//! locked" alone does not tell that human the vault is open behind another
//! window.
//!
//! ## What the three states are, and what they are not
//!
//! `vault_locked`, `door_disabled` and `app_not_running` are the three states the
//! door can be in when a call cannot be served, and they are distinct because the
//! fix is different in each: unlock, turn external access on, start the app. A
//! fourth arm, `door_unreachable`, covers the narrow race where the marker says
//! open but the socket does not answer (or answers with something that is not a
//! reply). It is NOT one of the three, because it is not a stable state a user
//! can be asked to fix by choosing one of the three actions; it is the
//! one-tick window the CLI door also records as "could not reach the running
//! app".
//!
//! Nothing here decides access. The authority is the desktop's own door, which
//! opens only while external access is on AND the vault is unlocked; this module
//! only chooses which sentence a closed door produces.

use serde_json::{json, Value};

/// Byte cap on a message relayed from the desktop.
///
/// The door is another process and its `error.message` is the one string in a
/// refusal this binary did not write. It says something useful that a shim-side
/// table cannot (a scope refusal names the folder kind, a limiter refusal names
/// the window), so it is relayed rather than replaced. But it is also a string
/// of unbounded length from an unreviewed producer, and the client puts it in
/// front of a model, so it is bounded here.
pub const MAX_RELAYED_MESSAGE_BYTES: usize = 240;

/// Marker for a relayed message that was cut, so a truncated one never reads as
/// a complete sentence that simply stops.
const TRUNCATION_MARKER: &str = " \u{2026}";

/// The reason emitted when a peer's `kind` is not a wire label. A closed value
/// rather than the peer's text, because a client branches on this field.
pub const GENERIC_REASON: &str = "refused";

/// Why a `tools/call` could not be served when the door is closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// External access is on, the vault is locked. The socket does not exist.
    VaultLocked,
    /// The master switch (the prefs field still named `cli_enabled`) is off.
    DoorDisabled,
    /// No status marker at all: the app is not running.
    AppNotRunning,
    /// The marker says open but the socket refused, reset, or answered with
    /// something that is not a reply. Not one of the three stable states.
    DoorUnreachable,
}

impl Refusal {
    /// The machine-readable reason, stable across releases. A client may branch
    /// on it, so it never carries anything but these four literals.
    pub fn reason(self) -> &'static str {
        match self {
            Refusal::VaultLocked => "vault_locked",
            Refusal::DoorDisabled => "door_disabled",
            Refusal::AppNotRunning => "app_not_running",
            Refusal::DoorUnreachable => "door_unreachable",
        }
    }

    /// One actionable sentence, written for a human the agent is talking to.
    ///
    /// Each names the ONE next action. The locked arm deliberately also says the
    /// connection stays open, because that is the fact the human cannot see and
    /// the one that decides whether they restart their client.
    pub fn sentence(self) -> &'static str {
        match self {
            Refusal::VaultLocked => {
                "The Myne vault is locked: unlock it in the Myne app and call this tool \
                 again, since this connection stays open and nothing needs restarting."
            }
            Refusal::DoorDisabled => {
                "External access is turned off in Myne: open Myne and switch external access \
                 on under Settings, AI, then call this tool again."
            }
            Refusal::AppNotRunning => {
                "The Myne app is not running: start Myne, unlock the vault, and call this tool \
                 again."
            }
            Refusal::DoorUnreachable => {
                "Myne did not answer on its local connection even though it is marked open: \
                 open Myne and switch external access off and on again, then call this tool \
                 again."
            }
        }
    }

    /// The MCP `tools/call` result for this refusal.
    pub fn result(self) -> Value {
        tool_error(self.reason(), self.sentence())
    }
}

/// A one-text-block tool error, with the reason in `structuredContent` too.
fn tool_error(reason: &str, sentence: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": sentence }],
        "structuredContent": { "reason": reason },
        "isError": true
    })
}

/// A refusal this process originated, with a static reason and sentence. Used
/// for request-shape refusals (`unknown_tool`) and for a reply from the door
/// that is not a result this server can forward.
pub fn local_refusal(reason: &'static str, sentence: &'static str) -> Value {
    tool_error(reason, sentence)
}

/// A refusal carrying the door's own closed `kind` and text.
///
/// The kind is validated as a wire label first: it is on the wire as a value a
/// client branches on, so a future or hostile peer must not be able to write
/// punctuation, whitespace or unbounded text into it. Anything that fails the
/// check becomes [`GENERIC_REASON`] while the sentence is still relayed.
pub fn door_refusal(kind: &str, message: &str) -> Value {
    let reason = if is_wire_label(kind) {
        kind
    } else {
        GENERIC_REASON
    };
    let text = if message.trim().is_empty() {
        "Myne refused this call. Nothing was changed.".to_string()
    } else {
        bounded_relayed_message(message)
    };
    tool_error(reason, &text)
}

/// A successful tool result, relayed from the door.
///
/// The door answers with a complete MCP `CallToolResult`. If it does not look
/// like one (no `content` array), forwarding it would emit a frame the client
/// rejects, so the call becomes a refusal that says so rather than a malformed
/// success. That arm is a bug in the host dispatcher, not a state a user
/// reaches, which is why its sentence does not tell them to do anything.
pub fn tool_success(result: Option<Value>) -> Value {
    match result {
        Some(value) if value.get("content").is_some_and(Value::is_array) => value,
        _ => local_refusal(
            "host_result_invalid",
            "Myne answered this call with a result this client cannot forward. No change was \
             confirmed, so nothing should be assumed to have happened.",
        ),
    }
}

/// Bound and flatten a message relayed from another process.
///
/// Two properties, both load-bearing because this string is DISPLAYED. It cannot
/// exceed [`MAX_RELAYED_MESSAGE_BYTES`], and it cannot contain a control
/// character: a newline would forge a line of output and a carriage return would
/// rewrite the one being read. Both bounds are in BYTES, so the guarantee holds
/// for a message of four-byte script as much as for ASCII.
pub fn bounded_relayed_message(raw: &str) -> String {
    let flatten = |ch: char| if ch.is_control() { ' ' } else { ch };
    if raw.len() <= MAX_RELAYED_MESSAGE_BYTES {
        return raw.chars().map(flatten).collect();
    }
    let mut out = String::with_capacity(MAX_RELAYED_MESSAGE_BYTES);
    let room = MAX_RELAYED_MESSAGE_BYTES - TRUNCATION_MARKER.len();
    for ch in raw.chars() {
        let ch = flatten(ch);
        if out.len() + ch.len_utf8() > room {
            break;
        }
        out.push(ch);
    }
    out.push_str(TRUNCATION_MARKER);
    out
}

/// Whether a string is a safe wire label: ASCII lower-case letters, digits and
/// `_`, at most 64 of them, not starting with a digit.
fn is_wire_label(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => {}
        _ => return false,
    }
    value.len() <= 64 && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_four_reasons_are_distinct_and_stable() {
        let reasons: Vec<&str> = [
            Refusal::VaultLocked,
            Refusal::DoorDisabled,
            Refusal::AppNotRunning,
            Refusal::DoorUnreachable,
        ]
        .iter()
        .map(|refusal| refusal.reason())
        .collect();
        assert_eq!(
            reasons,
            vec![
                "vault_locked",
                "door_disabled",
                "app_not_running",
                "door_unreachable"
            ]
        );
        let mut unique = reasons.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), reasons.len(), "two states share a reason");
    }

    #[test]
    fn every_sentence_is_one_actionable_sentence() {
        // Actionable means it names what the human should do, so it contains a
        // verb phrase rather than only naming the state; one sentence means one
        // full stop at the end and none inside. This is a shape check, not a
        // proof of helpfulness, and the copy is reviewed rather than derived.
        for refusal in [
            Refusal::VaultLocked,
            Refusal::DoorDisabled,
            Refusal::AppNotRunning,
            Refusal::DoorUnreachable,
        ] {
            let sentence = refusal.sentence();
            assert!(
                sentence.ends_with('.'),
                "{:?} must end in a full stop: {sentence}",
                refusal.reason()
            );
            assert!(
                !sentence.trim_end_matches('.').contains(". "),
                "{:?} is more than one sentence: {sentence}",
                refusal.reason()
            );
            assert!(
                sentence.contains("Myne"),
                "{:?} must name the product the human has to open: {sentence}",
                refusal.reason()
            );
            assert!(
                !sentence.contains('\n') && !sentence.contains('\u{2014}'),
                "{:?} carries a newline or an em dash",
                refusal.reason()
            );
        }
        // The locked arm says the connection stays open, because that decides
        // whether the human restarts their client.
        assert!(Refusal::VaultLocked.sentence().contains("stays open"));
    }

    #[test]
    fn a_refusal_is_a_tool_error_result_with_the_reason_beside_the_text() {
        let result = Refusal::VaultLocked.result();
        assert_eq!(result["isError"], true);
        assert_eq!(
            result["structuredContent"]["reason"], "vault_locked",
            "the machine-readable half must be present: {result}"
        );
        assert_eq!(result["content"][0]["type"], "text");
        assert_eq!(
            result["content"][0]["text"],
            Refusal::VaultLocked.sentence()
        );
    }

    #[test]
    fn a_relayed_kind_that_is_not_a_wire_label_becomes_the_generic_reason() {
        for hostile in [
            "Vault_Locked",
            "vault locked",
            "vault-locked",
            "1vault",
            "",
            "a\nb",
            &"x".repeat(65),
        ] {
            let result = door_refusal(hostile, "text");
            assert_eq!(
                result["structuredContent"]["reason"], GENERIC_REASON,
                "kind {hostile:?} was accepted as a wire label"
            );
        }
        // A legitimate one survives, digits and underscores included.
        assert_eq!(
            door_refusal("mcp_scope_2", "text")["structuredContent"]["reason"],
            "mcp_scope_2"
        );
    }

    #[test]
    fn a_relayed_message_is_bounded_and_single_line() {
        // The control character sits FIRST in the over-cap cases, so a truncation
        // cannot hide it: a fixture that puts it past the cut passes with the
        // replacement deleted, which is a fixture that cannot reach the defect.
        let over_cap = format!("/Users/somebody/secret-notes/{}", "x".repeat(4000));
        for hostile in [
            "line one\nline two\rforged".to_string(),
            format!("\n\r{over_cap}"),
            format!("{}\n\r{}", "y".repeat(200), "z".repeat(4000)),
        ] {
            let bounded = bounded_relayed_message(&hostile);
            assert!(
                bounded.len() <= MAX_RELAYED_MESSAGE_BYTES,
                "{} bytes is over the cap: {bounded:?}",
                bounded.len()
            );
            assert!(
                !bounded.chars().any(char::is_control),
                "a control character survived: {bounded:?}"
            );
        }
        // A cut message says so.
        assert!(bounded_relayed_message(&over_cap).ends_with(TRUNCATION_MARKER.trim()));
        // A short one is relayed verbatim: the point is the door's own wording.
        assert_eq!(
            bounded_relayed_message("Too many requests."),
            "Too many requests."
        );
        // The byte cap holds for four-byte characters too, where a character cap
        // would have passed.
        assert!(
            bounded_relayed_message(&"\u{1F600}".repeat(400)).len() <= MAX_RELAYED_MESSAGE_BYTES
        );
    }

    #[test]
    fn an_empty_relayed_message_still_says_something_true() {
        let result = door_refusal("rate_limited", "   ");
        assert_eq!(result["isError"], true);
        assert_eq!(result["structuredContent"]["reason"], "rate_limited");
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(
            text.starts_with("Myne refused this call."),
            "an empty message must not produce an empty refusal: {text:?}"
        );
    }

    #[test]
    fn a_forwardable_result_is_relayed_verbatim_and_a_malformed_one_is_not() {
        let forwarded = json!({
            "content": [{ "type": "text", "text": "two notes" }],
            "isError": false
        });
        assert_eq!(tool_success(Some(forwarded.clone())), forwarded);

        for malformed in [
            None,
            Some(json!({})),
            Some(json!({ "content": "not an array" })),
        ] {
            let result = tool_success(malformed);
            assert_eq!(result["isError"], true);
            assert_eq!(
                result["structuredContent"]["reason"], "host_result_invalid",
                "a result that is not a CallToolResult must not be forwarded: {result}"
            );
        }
    }
}
