// SPDX-License-Identifier: AGPL-3.0
//! Whether a backend can hold the edit format at all.
//!
//! The anchored format asks the model to copy existing text **exactly**, and a
//! small quantized model is unreliable at that. Without a gate the result is a
//! feature that is offered everywhere and fails constantly, which a user reads
//! as "the agent is broken" rather than as "this model is too small". So the
//! host runs a fixed, deterministic edit task once per backend and model
//! identity, and feeds the verdict into the existing per-feature capability
//! report, where a refusal already has a named cause and a place to be shown.
//!
//! **The threshold is not in this file.** [`ProbeThreshold`] is a parameter,
//! supplied by the host from a recorded file, because a pass bar invented in
//! code is a number nobody measured and nobody can find later. See
//! `scripts/agent-probe-threshold.json`.
//!
//! The probe is graded mechanically: the reply must parse into exactly one
//! `propose_edit` whose anchor places exactly once in the known text. Grading it
//! by asking a model would make the gate depend on the thing it is gating.

use super::edit::place;
use super::engine::{AgentEngine, AgentRequest, Content, Message, Role, AGENT_REQUEST_CLASS};
use super::error::AgentError;
use super::prompt::{parse_actions, system_instructions, AgentAction};
use serde::Serialize;

/// The note text the probe asks about. Short, unambiguous, and containing one
/// obviously-replaceable phrase that occurs exactly once.
pub const PROBE_BODY: &str = "Shopping list\n\n- apples\n- bread\n- milk\n";

/// The phrase the probe asks the model to replace.
pub const PROBE_TARGET: &str = "- bread";

/// What the probe asks it to become.
pub const PROBE_REPLACEMENT: &str = "- rye bread";

/// How many attempts, and how many must pass.
///
/// Supplied by the host from a recorded file rather than defaulted here, so
/// there is exactly one place the numbers live and it is a place that can carry
/// the measurements that produced them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeThreshold {
    /// How many times to ask.
    pub attempts: u8,
    /// How many of those must produce a placeable edit.
    pub required: u8,
    /// Whether these numbers were MEASURED or are still the recorded guess.
    ///
    /// Carried to the surface rather than left in a JSON comment, because the
    /// user meets this gate as a refusal: telling someone their model cannot
    /// make precise edits is a claim, and a claim resting on an unmeasured cut
    /// point should say so where it is made. The probe itself is a direct
    /// behavioural test either way; what is provisional is the cut point, not
    /// the question.
    pub provisional: bool,
}

/// Why one attempt did not count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProbeFailure {
    /// Nothing parsed as an action.
    NoAction,
    /// Something parsed, but not a single `propose_edit`.
    WrongAction,
    /// A `propose_edit` came back, but its anchor does not place exactly once.
    AnchorDoesNotPlace,
    /// It placed, but produced text the task did not ask for.
    WrongResult,
}

impl ProbeFailure {
    /// The failure's name, as a compile-time string. Every variant is a unit,
    /// so this carries nothing the model wrote.
    pub fn tag(&self) -> &'static str {
        match self {
            Self::NoAction => "no_action",
            Self::WrongAction => "wrong_action",
            Self::AnchorDoesNotPlace => "anchor_does_not_place",
            Self::WrongResult => "wrong_result",
        }
    }
}

/// One attempt's verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum AttemptVerdict {
    Passed,
    Failed(ProbeFailure),
}

/// The whole probe's verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeVerdict {
    /// Whether agent mode is offered on this backend.
    pub passed: bool,
    /// How many attempts produced a placeable edit.
    pub passes: u8,
    /// The threshold it was graded against, echoed so a report can show it.
    pub threshold: ProbeThreshold,
    /// Each attempt, in order.
    pub attempts: Vec<AttemptVerdict>,
}

/// The request one probe attempt sends.
pub fn probe_request() -> AgentRequest {
    AgentRequest {
        messages: vec![
            Message {
                role: Role::System,
                content: vec![Content::Trusted(system_instructions())],
            },
            Message {
                role: Role::User,
                content: vec![Content::Trusted(format!(
                    "This is the whole of note probe-1:\n{PROBE_BODY}\n\
                     Propose one edit that changes the line \"{PROBE_TARGET}\" to \
                     \"{PROBE_REPLACEMENT}\". Reply with exactly one propose_edit action \
                     and nothing else."
                ))],
            },
        ],
    }
}

/// Grade one reply.
pub fn grade(reply: &str) -> AttemptVerdict {
    let actions = parse_actions(reply);
    if actions.is_empty() {
        return AttemptVerdict::Failed(ProbeFailure::NoAction);
    }
    let edits: Vec<&AgentAction> = actions
        .iter()
        .filter(|a| matches!(a, AgentAction::ProposeEdit { .. }))
        .collect();
    if edits.len() != 1 {
        return AttemptVerdict::Failed(ProbeFailure::WrongAction);
    }
    let AgentAction::ProposeEdit {
        anchor,
        replacement,
        ..
    } = edits[0]
    else {
        return AttemptVerdict::Failed(ProbeFailure::WrongAction);
    };
    match place(PROBE_BODY, anchor, replacement) {
        Err(_) => AttemptVerdict::Failed(ProbeFailure::AnchorDoesNotPlace),
        Ok(result) => {
            if result.contains(PROBE_REPLACEMENT) && !result.contains("- bread\n") {
                AttemptVerdict::Passed
            } else {
                AttemptVerdict::Failed(ProbeFailure::WrongResult)
            }
        }
    }
}

/// Run the probe against a backend.
pub async fn run_probe(
    engine: &dyn AgentEngine,
    threshold: ProbeThreshold,
) -> Result<ProbeVerdict, AgentError> {
    let request = probe_request();
    let mut attempts = Vec::with_capacity(threshold.attempts as usize);
    let mut passes = 0u8;
    for _ in 0..threshold.attempts {
        // The probe deliberately ignores the disclosure counter: it is a fixed
        // synthetic string, not vault text, so counting it into the run summary
        // would report characters that never came from a note.
        let reply = engine.complete(AGENT_REQUEST_CLASS, &request).await?.reply;
        let v = grade(&reply);
        // Why an attempt did not count (myne-md/myne#546). The user meets this
        // gate as "the agent is unavailable", and until now the reason existed
        // only inside the returned value: a run that never started left no
        // trace of whether the backend wrote nothing, wrote the wrong verb, or
        // wrote an anchor that does not place. The verdict is a closed enum, so
        // there is nothing here the model chose.
        tracing::debug!(
            target: "myne_core::agent",
            event = "probe_attempt",
            attempt = attempts.len() + 1,
            verdict = match &v {
                AttemptVerdict::Passed => "passed",
                AttemptVerdict::Failed(f) => f.tag(),
            },
        );
        if v == AttemptVerdict::Passed {
            passes += 1;
        }
        attempts.push(v);
    }
    tracing::debug!(
        target: "myne_core::agent",
        event = "probe_done",
        passes,
        attempts = threshold.attempts,
        required = threshold.required,
        passed = passes >= threshold.required,
    );
    Ok(ProbeVerdict {
        passed: passes >= threshold.required,
        passes,
        threshold,
        attempts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::agent::engine::AgentCompletion;
    use crate::test_support::block_on;
    use std::sync::Mutex;

    fn good_reply() -> String {
        format!(
            r#"{{"action":"propose_edit","note_id":"probe-1","anchor":"{PROBE_TARGET}","replacement":"{PROBE_REPLACEMENT}"}}"#
        )
    }

    struct Fixed(Mutex<Vec<String>>);

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl AgentEngine for Fixed {
        async fn complete(
            &self,
            _c: super::super::engine::AgentRequestClass,
            _r: &AgentRequest,
        ) -> Result<AgentCompletion, AgentError> {
            Ok(AgentCompletion {
                reply: self
                    .0
                    .lock()
                    .unwrap()
                    .pop()
                    .unwrap_or_else(|| "nothing".to_string()),
                chars_off_device: None,
            })
        }
    }

    fn engine(replies: &[&str]) -> Fixed {
        Fixed(Mutex::new(
            replies.iter().rev().map(|s| s.to_string()).collect(),
        ))
    }

    #[test]
    fn a_correct_reply_passes() {
        assert_eq!(grade(&good_reply()), AttemptVerdict::Passed);
    }

    #[test]
    fn a_reply_with_no_action_fails_by_name() {
        assert_eq!(
            grade("I would change the bread line."),
            AttemptVerdict::Failed(ProbeFailure::NoAction)
        );
    }

    #[test]
    fn a_reply_with_the_wrong_action_fails_by_name() {
        assert_eq!(
            grade(r#"{"action":"list_scope"}"#),
            AttemptVerdict::Failed(ProbeFailure::WrongAction)
        );
    }

    // The case the whole gate exists for: an anchor that is nearly right.
    #[test]
    fn an_anchor_the_model_copied_badly_fails_by_name() {
        let reply = r#"{"action":"propose_edit","note_id":"probe-1","anchor":"- Bread","replacement":"- rye bread"}"#;
        assert_eq!(
            grade(reply),
            AttemptVerdict::Failed(ProbeFailure::AnchorDoesNotPlace)
        );
    }

    #[test]
    fn an_ambiguous_anchor_fails_rather_than_being_placed_at_the_first_match() {
        let reply =
            r#"{"action":"propose_edit","note_id":"probe-1","anchor":"- ","replacement":"* "}"#;
        assert_eq!(
            grade(reply),
            AttemptVerdict::Failed(ProbeFailure::AnchorDoesNotPlace)
        );
    }

    #[test]
    fn a_backend_over_the_bar_is_offered_agent_mode() {
        let g = good_reply();
        let e = engine(&[&g, &g, "junk"]);
        let v = block_on(run_probe(
            &e,
            ProbeThreshold {
                attempts: 3,
                required: 2,
                provisional: false,
            },
        ))
        .unwrap();
        assert!(v.passed);
        assert_eq!(v.passes, 2);
        assert_eq!(v.attempts.len(), 3);
    }

    #[test]
    fn a_backend_under_the_bar_is_not_offered_agent_mode() {
        let g = good_reply();
        let e = engine(&[&g, "junk", "junk"]);
        let v = block_on(run_probe(
            &e,
            ProbeThreshold {
                attempts: 3,
                required: 2,
                provisional: false,
            },
        ))
        .unwrap();
        assert!(!v.passed);
        assert_eq!(v.passes, 1);
    }

    #[test]
    fn the_verdict_echoes_the_threshold_it_was_graded_against() {
        let t = ProbeThreshold {
            attempts: 1,
            required: 1,
            provisional: false,
        };
        let g = good_reply();
        let v = block_on(run_probe(&engine(&[&g]), t)).unwrap();
        assert_eq!(
            v.threshold, t,
            "a report can show the bar, not just the result"
        );
    }

    #[test]
    fn the_probe_target_occurs_exactly_once_in_the_probe_body() {
        // If it ever did not, every model would fail on ambiguity and the gate
        // would be measuring the fixture rather than the model.
        assert!(place(PROBE_BODY, PROBE_TARGET, "x").is_ok());
    }
}
