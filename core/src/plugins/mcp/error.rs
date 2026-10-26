// SPDX-License-Identifier: AGPL-3.0
//! Why an external connection's tool call was refused.
//!
//! Every variant here is a *decision the host made*, and each one is answered as
//! a value rather than as a failure the caller has to interpret from prose: an
//! agent relays this to a person verbatim, so the reason has to be a closed
//! label it can branch on and the sentence has to name the one next action.
//!
//! **A refusal is never a protocol error.** That is the shim's rule
//! (`mcp/src/errors.rs`) and it holds here for the same reason: a JSON-RPC error
//! reads to a client as a broken server and it reconnects, which is exactly the
//! failure the connection is built to survive.
//!
//! ## The label is wire-shaped
//!
//! [`McpToolError::reason`] returns the snake-case label the shim puts in
//! `structuredContent.reason`, and the shim validates that label as a wire value
//! before relaying it (`is_wire_label` in `mcp/src/errors.rs`: lower-case ASCII,
//! digits, underscores). The two are separate crates with no shared type by
//! design, so `every_reason_is_a_wire_label` below holds the shape rather than
//! leaving it to review.
//!
//! ## What no variant carries
//!
//! No note body, no folder contents, no path, no plaintext. A refusal may name
//! the note id or the folder the CALLER asked for, because the caller already
//! has it, and nothing else.

use serde::Serialize;

/// One refusal an MCP read may produce, with the cause as data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum McpToolError {
    /// The declared connection name has no grant on this device. The resolved
    /// scope is therefore empty and every tool refuses, rather than answering as
    /// an empty vault (which would read as "your vault has no notes").
    #[serde(rename = "no_grant")]
    NoGrant,
    /// The search query was empty. Refused rather than answered because an empty
    /// query is a request to enumerate the whole scope, and the search tool is
    /// the one verb a caller can loop to approximate reading everything.
    #[serde(rename = "empty_query")]
    EmptyQuery,
    /// The id is not in the vault index at all.
    #[serde(rename = "unknown_note")]
    UnknownNote { note_id: String },
    /// The note exists but sits outside the connection's frozen folder set.
    #[serde(rename = "out_of_scope")]
    OutOfScopeNote { note_id: String },
    /// The `folder` argument to a search is outside the frozen folder set, so
    /// narrowing to it would be a request to read a folder the user did not
    /// grant.
    #[serde(rename = "out_of_scope_folder")]
    OutOfScopeFolder { folder: String },
    /// The host could not read the index or the note. Collapsed into one label on
    /// purpose: the internal cause is an IO or decode detail that must not cross
    /// to a process Myne does not ship (`core/AGENTS.md` "Error modelling").
    #[serde(rename = "vault_unavailable")]
    VaultUnavailable,
}

impl McpToolError {
    /// The machine-readable reason, stable across releases.
    ///
    /// Snake case, because this value becomes the shim's `reason` field and the
    /// shim refuses anything that is not a wire label.
    pub fn reason(&self) -> &'static str {
        match self {
            McpToolError::NoGrant => "no_grant",
            McpToolError::EmptyQuery => "empty_query",
            McpToolError::UnknownNote { .. } => "unknown_note",
            McpToolError::OutOfScopeNote { .. } => "out_of_scope",
            McpToolError::OutOfScopeFolder { .. } => "out_of_scope_folder",
            McpToolError::VaultUnavailable => "vault_unavailable",
        }
    }

    /// One actionable sentence, for a human the agent is talking to.
    ///
    /// Every arm names what the person can do next. The two scope arms say the
    /// user can widen the grant, because "refused" with no route forward is the
    /// shape that makes an agent give up and the user never learn why. None of
    /// them repeats the note id: the caller already has it, and a refusal is not
    /// the place to echo vault content back.
    pub fn message(&self) -> &'static str {
        match self {
            McpToolError::NoGrant => {
                "This connection has no approved scope in Myne: approve it under Settings, AI in \
                 the Myne app, then call this tool again."
            }
            McpToolError::EmptyQuery => {
                "The search had no query text: send the words to look for, since an empty search \
                 is a request to Myne to list everything this connection may read."
            }
            McpToolError::UnknownNote { .. } => {
                "No note with that id exists in this vault: call note_search to find the note's \
                 id, then read that id."
            }
            McpToolError::OutOfScopeNote { .. } => {
                "That note is outside the folders this connection may read: ask the user to add \
                 its folder to the connection's scope in Myne, then call this tool again."
            }
            McpToolError::OutOfScopeFolder { .. } => {
                "That folder is outside the folders this connection may read: ask the user to add \
                 it to the connection's scope in Myne, then call this tool again."
            }
            McpToolError::VaultUnavailable => {
                "Myne could not read the vault for this call: unlock the vault in the Myne app \
                 and call this tool again."
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every variant, so a new one cannot skip the shape checks below by never
    /// being listed.
    fn all() -> Vec<McpToolError> {
        vec![
            McpToolError::NoGrant,
            McpToolError::EmptyQuery,
            McpToolError::UnknownNote {
                note_id: "n".into(),
            },
            McpToolError::OutOfScopeNote {
                note_id: "n".into(),
            },
            McpToolError::OutOfScopeFolder {
                folder: "Private".into(),
            },
            McpToolError::VaultUnavailable,
        ]
    }

    #[test]
    fn every_reason_is_a_wire_label() {
        // The shim's rule, restated: lower-case ASCII, digits, underscores, at
        // most 64 characters, not starting with a digit. A reason that failed
        // this would be relayed as the generic `refused` and the caller would
        // lose the distinction this enum exists for.
        for error in all() {
            let reason = error.reason();
            let mut chars = reason.chars();
            assert!(
                chars.next().is_some_and(|c| c.is_ascii_lowercase()),
                "{reason} must start with a lower-case letter"
            );
            assert!(
                reason.len() <= 64
                    && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "{reason} is not a wire label"
            );
        }
    }

    #[test]
    fn reasons_are_distinct() {
        let mut reasons: Vec<&str> = all().iter().map(McpToolError::reason).collect();
        let total = reasons.len();
        reasons.sort_unstable();
        reasons.dedup();
        assert_eq!(reasons.len(), total, "two variants share a reason");
    }

    #[test]
    fn every_message_is_one_actionable_sentence() {
        for error in all() {
            let message = error.message();
            assert!(
                message.ends_with('.'),
                "{:?} must end in a full stop: {message}",
                error.reason()
            );
            assert!(
                !message.trim_end_matches('.').contains(". "),
                "{:?} is more than one sentence: {message}",
                error.reason()
            );
            assert!(
                message.contains("Myne") || message.contains("note_search"),
                "{:?} must name the product or the next call: {message}",
                error.reason()
            );
            assert!(
                !message.contains('\n') && !message.contains('\u{2014}'),
                "{:?} carries a newline or an em dash",
                error.reason()
            );
            // The shim bounds a relayed message at 240 bytes
            // (`mcp/src/errors.rs::MAX_RELAYED_MESSAGE_BYTES`); a sentence that
            // exceeds it would be cut before the reader gets the action.
            assert!(
                message.len() <= 240,
                "{:?} is {} bytes, over the shim's relay cap",
                error.reason(),
                message.len()
            );
        }
    }

    /// The serde `kind` and [`McpToolError::reason`] are two spellings of one
    /// label, so they have to agree: the shim relays `reason`, and the host's
    /// door refusal carries the serialized `kind`. Two spellings that drifted
    /// would make the same refusal identifiable by one label on one path and a
    /// different one on the other.
    #[test]
    fn the_serialised_kind_is_the_reason() {
        for error in all() {
            let value = serde_json::to_value(&error).unwrap();
            assert_eq!(
                value["kind"],
                error.reason(),
                "{error:?} serialises under a label its reason() does not return"
            );
        }
    }

    #[test]
    fn a_refusal_serialises_with_the_reason_and_the_cause_as_data() {
        let value = serde_json::to_value(McpToolError::OutOfScopeNote {
            note_id: "abc".into(),
        })
        .unwrap();
        assert_eq!(value["kind"], "out_of_scope");
        assert_eq!(value["detail"]["note_id"], "abc");
        let bare = serde_json::to_value(McpToolError::NoGrant).unwrap();
        assert_eq!(bare["kind"], "no_grant");
    }
}
