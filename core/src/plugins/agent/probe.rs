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
                content: vec![Content::Trusted(system_instructions(None))],
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

/// Which attempt is in flight, so the surface can say so (myne-md/myne#575).
///
/// **Counts only, and that is what makes it safe to send anywhere.** Both
/// fields are small integers the host chose; nothing here is derived from a
/// reply, so this crosses IPC without joining any of the lists in
/// `src-tauri/AGENTS.md`.
///
/// `of` is the threshold's ALLOWANCE rather than a promise: since the early exit
/// below, a run that settles at 2 of 3 simply stops, and "2 of 3" then reads as
/// the good news it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeProgress {
    /// 1-based, so it reads as "attempt 2 of 3" without arithmetic.
    pub attempt: u8,
    /// The most that will be asked.
    pub of: u8,
}

/// Run the probe against a backend.
///
/// `on_attempt` is called BEFORE each request goes out, so the surface can say
/// which attempt it is waiting on rather than showing one unchanging label for
/// what was measured at 40 seconds. A sink rather than a channel because this
/// crate has no IPC: the host adapts it, exactly as `agent_start` does for its
/// run view.
pub async fn run_probe(
    engine: &dyn AgentEngine,
    threshold: ProbeThreshold,
    // `Sync` because this crate's async fns must produce `Send` futures on the
    // native targets, and the sink is held across an `await`. A closure that
    // captures a `Channel` satisfies it; so does one that captures nothing.
    on_attempt: &(dyn Fn(ProbeProgress) + Sync),
) -> Result<ProbeVerdict, AgentError> {
    let request = probe_request();
    let mut attempts = Vec::with_capacity(threshold.attempts as usize);
    let mut passes = 0u8;
    for n in 0..threshold.attempts {
        on_attempt(ProbeProgress {
            attempt: n + 1,
            of: threshold.attempts,
        });
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
        // **Stop once the verdict cannot change** (myne-md/myne#575). The loop
        // used to run every attempt unconditionally, so a 2-of-3 threshold that
        // had already seen two passes spent a third provider request whose
        // result was arithmetically irrelevant. Both measured runs did exactly
        // that, and in both the wasted attempt happened to be the slowest: 22.3s
        // of 40.6s, and 13.8s of 26.5s.
        //
        // The saving is not the 1/3 it looks like. Three identical requests to
        // the same provider came back in 4.4s, 13.9s and 22.3s, so what stopping
        // early removes is the TAIL: you wait for the slowest of two rather than
        // the slowest of three, and the difference between those grows with the
        // variance rather than with the mean.
        //
        // Both directions, because only checking for the pass would leave a
        // failing backend paying full price to be told what the second failure
        // already settled. `remaining` is what is still unasked, so
        // `passes + remaining < required` is "even if everything left passes, it
        // cannot reach the bar".
        let remaining = threshold.attempts - attempts.len() as u8;
        if passes >= threshold.required || passes + remaining < threshold.required {
            break;
        }
    }
    tracing::debug!(
        target: "myne_core::agent",
        event = "probe_done",
        passes,
        // What was actually ASKED, beside what the threshold allowed. The two
        // used to be the same number by construction; since the early exit they
        // differ whenever the verdict settled before the last attempt, and the
        // gap is the whole saving, so reporting only the allowance would hide
        // the thing this line is now most useful for.
        asked = attempts.len(),
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
                truncated: false,
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

    /// How many replies the engine has left, which is how many it was NOT
    /// asked for. The early exit is a claim about requests that did not go out,
    /// and the returned verdict alone cannot prove one.
    fn unasked(e: &Fixed) -> usize {
        e.0.lock().unwrap().len()
    }

    /// The progress sink for tests that are not about progress.
    fn ignore(_: ProbeProgress) {}

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
            &ignore,
        ))
        .unwrap();
        assert!(v.passed);
        assert_eq!(v.passes, 2);
        // **Two attempts, not three** (myne-md/myne#575). The bar is 2 of 3, so
        // the second pass settles it and the third request cannot change the
        // answer. Asserted on the ENGINE as well as on the verdict, because a
        // shorter `attempts` vec would also be produced by simply recording
        // less, and what this is about is a request that never went out. In the
        // two measured runs that request was the slowest of the three.
        assert_eq!(v.attempts.len(), 2);
        assert_eq!(unasked(&e), 1, "the third reply was never asked for");
    }

    #[test]
    fn a_backend_under_the_bar_stops_as_soon_as_it_cannot_reach_it() {
        // The other direction, and the one a pass-only check would miss: two
        // failures out of three mean the bar of 2 is already unreachable, so a
        // failing backend must not pay full price to be told what it already
        // knows.
        let g = good_reply();
        let e = engine(&["junk", "junk", &g]);
        let v = block_on(run_probe(
            &e,
            ProbeThreshold {
                attempts: 3,
                required: 2,
                provisional: false,
            },
            &ignore,
        ))
        .unwrap();
        assert!(!v.passed);
        assert_eq!(v.attempts.len(), 2);
        assert_eq!(unasked(&e), 1, "the third reply was never asked for");
    }

    #[test]
    fn a_verdict_that_needs_every_attempt_still_takes_every_attempt() {
        // The early exit must not become "stop at 2 whatever the numbers say".
        // One pass and one failure leaves the bar reachable, so the third
        // attempt is the one that decides it.
        let g = good_reply();
        let e = engine(&[&g, "junk", &g]);
        let v = block_on(run_probe(
            &e,
            ProbeThreshold {
                attempts: 3,
                required: 2,
                provisional: false,
            },
            &ignore,
        ))
        .unwrap();
        assert!(v.passed);
        assert_eq!(v.passes, 2);
        assert_eq!(v.attempts.len(), 3);
        assert_eq!(unasked(&e), 0);
    }

    #[test]
    fn the_surface_is_told_which_attempt_is_in_flight() {
        // Reported BEFORE each request rather than after, because the whole
        // point is the wait: a progress line that arrives when the attempt
        // finishes describes a wait that is already over.
        let g = good_reply();
        let e = engine(&[&g, "junk", &g]);
        let seen = Mutex::new(Vec::new());
        let sink = |p: ProbeProgress| seen.lock().unwrap().push((p.attempt, p.of));
        block_on(run_probe(
            &e,
            ProbeThreshold {
                attempts: 3,
                required: 2,
                provisional: false,
            },
            &sink,
        ))
        .unwrap();
        assert_eq!(*seen.lock().unwrap(), vec![(1, 3), (2, 3), (3, 3)]);
    }

    #[test]
    fn progress_stops_when_the_probe_does() {
        // No line for an attempt that never runs: the counter must not tick to
        // "3 of 3" and then finish, which would report a request nobody made.
        let g = good_reply();
        let seen = Mutex::new(Vec::new());
        let sink = |p: ProbeProgress| seen.lock().unwrap().push(p.attempt);
        block_on(run_probe(
            &engine(&[&g, &g, "junk"]),
            ProbeThreshold {
                attempts: 3,
                required: 2,
                provisional: false,
            },
            &sink,
        ))
        .unwrap();
        assert_eq!(*seen.lock().unwrap(), vec![1u8, 2]);
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
            &ignore,
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
        let v = block_on(run_probe(&engine(&[&g]), t, &ignore)).unwrap();
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
