// SPDX-License-Identifier: AGPL-3.0-only
//! The narrow generation seam the agent loop depends on.
//!
//! This is why the loop can live in a crate that has no AI engine in it. The
//! engine stays in each client (`local_inference` on desktop); the loop depends
//! on this trait, and the dependency runs core-to-host rather than host-to-core.
//!
//! **Note-derived spans are `Zeroizing`, and the type says so.** `threat-model.md`
//! §7 requires assembled prompts to live only in RAM, `Zeroizing`-scoped, and an
//! agent run holds them longer than chat does: a transcript survives several IPC
//! round-trips and the whole time the review screen is open. Making it the
//! variant's payload rather than a discipline every call site remembers is what
//! keeps that true when a fifth call site appears.
//!
//! **Provenance, not defence.** [`Content`] distinguishes text the host wrote
//! from text that came out of a note, and it exists so the host can tokenize the
//! untrusted spans with special-token parsing disabled. That defence lives where
//! tokenization happens, which is not here, and this module must not claim
//! otherwise: on a remote backend the far side tokenizes and the guarantee
//! degrades from structural to behavioural (`decisions/ai/0461`,
//! `threat-model.md` §7). Marking provenance is what core can honestly do.
//!
//! **The request class is a constant, not a parameter.** [`AGENT_REQUEST_CLASS`]
//! is what every iteration passes, in the loop's own code, and it is
//! user-initiated because an agent run is something the user asked for. The
//! seam takes the class so the host can route it through its existing
//! described-backend registry (`decisions/ai/0462`) rather than being handed an
//! already-chosen engine and having to trust that the choice was right.

use super::error::AgentError;
use serde::Serialize;
use zeroize::Zeroizing;

/// The two request classes the provider seam distinguishes.
///
/// Mirrors the host's own class enum deliberately narrowly: two variants, no
/// behaviour, and no mapping table. The host maps this to its registry's class
/// at the seam boundary. A third variant here would be a change to
/// `decisions/ai/0462`, not to this file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentRequestClass {
    /// The user asked for this.
    UserInitiated,
    /// It fired without being asked. Barred from a remote backend at the seam.
    Ambient,
}

/// The class every agent iteration carries.
///
/// A `const`, so it cannot be read from a payload and cannot vary per call. An
/// agent run classed ambient could not reach a remote backend at all, so this is
/// forced by the design rather than chosen for convenience.
pub const AGENT_REQUEST_CLASS: AgentRequestClass = AgentRequestClass::UserInitiated;

/// A span of prompt content, tagged by where it came from.
///
/// **Not `Serialize`, deliberately.** These spans carry note plaintext, and a
/// type that serializes by default is a type that ends up in a log line or an
/// event payload without anyone deciding to put it there. Nothing about a
/// request crosses IPC: what the user sees is the proposal, which has its own
/// types.
#[derive(Clone)]
pub enum Content {
    /// Written by the host. Tokenized normally.
    Trusted(String),
    /// Came out of a note, so it is attacker-influenceable (a note synced from a
    /// compromised device, or an imported one). The host tokenizes this with
    /// special-token parsing disabled where it can.
    ///
    /// `Zeroizing` because this is note plaintext and it lives for the length of
    /// a run.
    UntrustedNote(Zeroizing<String>),
}

/// Prints a SHAPE, never the text.
///
/// **The module doc one screen up argues this for `Serialize` and the argument
/// is the same for `Debug`.** A derived `Debug` is how plaintext reaches a log
/// line, a panic message or an `assert_eq!` diff without anyone deciding to put
/// it there, and `Zeroizing`'s own `Debug` forwards to the inner `String`, so
/// wrapping bought nothing here. Nothing logs these types today: this closes a
/// trap rather than a leak, which is the cheapest moment to close one.
///
/// The arm name is kept because it is the security-relevant half — whether a
/// span was trusted or note-derived is the thing a reader needs — and the length
/// because a zero-length span is a real bug shape.
impl std::fmt::Debug for Content {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Content::Trusted(t) => write!(f, "Trusted(<{} chars>)", t.chars().count()),
            Content::UntrustedNote(t) => {
                write!(f, "UntrustedNote(<{} chars>)", t.chars().count())
            }
        }
    }
}

impl Content {
    /// A note-derived span, wrapped.
    pub fn note(text: impl Into<String>) -> Self {
        Content::UntrustedNote(Zeroizing::new(text.into()))
    }

    /// The span's text, whichever arm it is.
    pub fn text(&self) -> &str {
        match self {
            Content::Trusted(t) => t,
            Content::UntrustedNote(t) => t,
        }
    }
}

// Hand-written rather than derived: `Zeroizing` does not carry `PartialEq`
// through, and comparing spans is a test convenience rather than something
// production does.
impl PartialEq for Content {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Content::Trusted(a), Content::Trusted(b)) => a == b,
            (Content::UntrustedNote(a), Content::UntrustedNote(b)) => **a == **b,
            _ => false,
        }
    }
}
impl Eq for Content {}

/// Who is speaking in a role-structured request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    System,
    User,
    Assistant,
}

/// One turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub role: Role,
    pub content: Vec<Content>,
}

/// A role-structured request.
///
/// Never one spliced prompt string. The structure is what lets the host emit its
/// own role scaffold as the only special-tokenized part, and it is also what
/// survives the remote arm: a role-structured body is the mitigation that
/// remains when the token-level one cannot cross the boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRequest {
    pub messages: Vec<Message>,
}

// **`render_chatml` was removed here** (myne-md/myne#531 review round six).
//
// It rendered a role-structured request into one FLAT ChatML string, and its doc
// claimed the trusted/untrusted span mapping lived here "because it IS the
// mitigation" and was therefore "shared and tested once". Neither half was true
// any more: the flat rendering is the shape the shipped regression used, the fix
// replaced it with the engine's ROLE-STRUCTURED surface, and every remaining
// call site was inside a `#[cfg(test)]` module. Core kept a dead mitigation that
// read as live, with four tests pinning behaviour nothing performed.
//
// Where the mapping lives now, and why it is not here: the role-structured
// shaping is `chat_shape` in `src-tauri/src/plugins/agent/adapters.rs`, because
// its output is the engine's `ChatMessage`, a desktop type this crate does not
// and should not depend on. **A mobile port owes its own**, together with
// `adapters.rs`'s `the_agent_generation_call_is_the_role_structured_one`, which
// is what stops the flat entry coming back. Saying so here rather than leaving
// the reader to infer it from an absence.

/// One model reply, plus what asking for it actually cost in disclosure terms.
///
/// The reply alone was the earlier shape, and it could not answer the one
/// question the post-run summary exists to answer: how much of the vault left
/// the machine. The design carries no volume bound on the remote arm, so the
/// summary is the only place a user ever learns the size of what happened, and
/// a summary that cannot say it is disclosure in name only.
/// Prints a shape, for the reason [`Content`]'s `Debug` does: `reply` is model
/// output derived from note plaintext, and a derived `Debug` puts it wherever a
/// `{:?}` happens to be.
impl std::fmt::Debug for AgentCompletion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentCompletion")
            .field(
                "reply",
                &format_args!("<{} chars>", self.reply.chars().count()),
            )
            .field("truncated", &self.truncated)
            .field("chars_off_device", &self.chars_off_device)
            .finish()
    }
}

#[derive(Clone)]
pub struct AgentCompletion {
    /// What the model said.
    pub reply: String,
    /// Whether the provider reported that this reply was CUT OFF at the token
    /// ceiling rather than finished.
    ///
    /// The ceiling and this flag arrived together (myne-md/myne#597), and that
    /// is the argument for the flag existing: a reply stopped mid-token is
    /// usually broken JSON, so it parses to zero actions, and without this the
    /// loop tells the model "No valid action found" and spends a barren strike
    /// on a format error the model did not make. Three of those end the run
    /// with a stall verdict that names the wrong cause.
    ///
    /// **Only the host can fill this in honestly**, for the same reason as
    /// `chars_off_device` below: the provider's stop reason is on the wire, and
    /// core never sees it. Inferring it here from the reply text would be a
    /// guess, and the guess is costly in one direction: telling a model that
    /// answered correctly to answer more briefly teaches it to truncate itself.
    /// A host with no ceiling to impose reports `false`, which is a claim
    /// rather than a default.
    pub truncated: bool,
    /// Characters that LEFT THE DEVICE for this one request.
    ///
    /// `None` on a local backend, and that is deliberately not `Some(0)`: one
    /// says no transmission happened, the other says a transmission happened
    /// and carried nothing. The summary shows a figure only on the remote arm,
    /// so it needs the two to be distinguishable rather than a zero it has to
    /// interpret.
    ///
    /// **Only the host can fill this in honestly.** Whether the request routes
    /// remote is a property of the arm the host's registry resolves for this
    /// class, and core has no way to see it. A count computed here from the
    /// rendered prompt would be right about the size and wrong about whether it
    /// went anywhere.
    pub chars_off_device: Option<usize>,
}

/// Generation, as the agent loop needs it.
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait AgentEngine: Send + Sync {
    /// Produce one reply.
    ///
    /// The host routes `class` through its own registry and is the place a
    /// remote backend gets refused an ambient request. Returning
    /// [`AgentError::Cancelled`] is how an engine reports that the run's flag
    /// was set mid-generation.
    async fn complete(
        &self,
        class: AgentRequestClass,
        request: &AgentRequest,
    ) -> Result<AgentCompletion, AgentError>;
}

// **No `mod tests` here any more, and that is a statement rather than an
// omission.** Its four tests all drove `render_chatml`, which was removed above:
// they pinned that untrusted spans were sanitized and trusted ones were not, in
// a function nothing production called. The property they were about is real and
// is now pinned where it runs, in `src-tauri/src/plugins/agent/adapters.rs`
// (`the_agent_instruction_lands_in_the_system_slot_not_the_user_turn`,
// `an_untrusted_span_in_a_system_message_is_filtered_rather_than_trusted`,
// `turn_content_is_left_for_the_engine_to_filter`, and the routing pin that
// stops the flat entry coming back). Tests that pass against code nothing calls
// are the same non-evidence as a guard that has stopped checking.
