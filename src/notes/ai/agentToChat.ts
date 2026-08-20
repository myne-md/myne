// Agent run → chat-transcript orchestration.
//
// The sibling of `aiToChat.ts`, and it exists for the same reason: a capability
// that used to render into a surface of its own now renders into the one
// transcript. `design-notes/ai/0515` already said the entry point was chat
// ("A run starts from chat with the open note as the default scope"); what
// shipped put a second composer beside the chat one instead, so the tab offered
// two places to type. This module is the half of closing that which does not
// belong in a component: appending the run's turns, starting it, and mirroring
// each settled step onto its turn.
//
// **`settleRunIntoChat` is the ONE place a step settles**, and that is the point
// rather than a convenience. The mirror used to live in a render effect on the
// turn, which meant a cross-store write whose correctness rested on an
// over-broad dependency array being absorbed by an equality check. It also had
// to be written where it could see BOTH callers of `settleStep`: this module's
// own start, and the scope-approval resume in `AgentProgress`. Putting the
// mirror in the settle function covers both by construction, which is what the
// effect was approximating.
//
// **It deliberately does not own the capability probe.** The probe's verdict is
// composer state: it gates whether Send is offered at all, and it must not fire
// until the user actually sends in Edit mode, because on a remote provider the
// probe issues `threshold.attempts` third-party requests (TB13,
// `design-notes/ai/0515`). Moving it here would make "start a run" and "find
// out whether a run is possible" the same call, which is how a mount effect
// grows back.
//
// Both stores are AS1-class RAM, dropped on lock: the transcript through
// `clearChat`, the proposal through `clearAgentForLock`. Nothing here writes to
// disk and nothing here logs the task, which is the user's own words.

import { agentStart, type AgentStepResult, type ScopeGrant } from "../../lib/agent-run";
import {
  beginRun,
  currentRunEpoch,
  failRun,
  getAgent,
  settleStep,
} from "../agent/agentStore";
import { failAgentTurn, sendAgentTurn, settleAgentTurn } from "./chatStore";

/** The already-localized strings the run's turns render.
 *
 *  Passed in rather than resolved here: this module is not a component, and
 *  `src/CLAUDE.md` bans freezing a resolved string at module scope (it would
 *  capture the boot language). The caller has a `t` in hand. */
export interface AgentRunCopy {
  /** What the user turn's scope chip says: "This note", or the folder name. */
  scopeLabel: string;
  /** The sentence for a start that never landed. */
  startFailed: string;
}

/**
 * Settle a step into the run store AND onto its transcript turn.
 *
 * Every path that settles a step goes through here. A run that stopped to ASK
 * has not settled in the sense the turn cares about: its step returned, so
 * `running` is false, but the loop is paused on a question the scope dialog is
 * putting to the user, and freezing there would print "the agent proposed no
 * changes" underneath a dialog about to make it propose some.
 *
 * The turn takes COUNTS only. The proposal's anchors and replacements are text
 * copied verbatim out of note bodies; they stay in `agentStore`, which every
 * vault-leaving path clears (`design-notes/ai/0517`).
 */
export function settleRunIntoChat(result: AgentStepResult, epoch: number): void {
  // A step that landed after the vault was left is dropped by the run store,
  // and its counts must not reach the transcript either.
  if (!settleStep(result, epoch)) return;
  const agent = getAgent();
  if (agent.view === null || agent.end?.kind === "awaitingScope") return;
  settleAgentTurn({
    runId: agent.view.runId,
    edits: agent.proposal.edits.length,
    newNotes: agent.proposal.newNotes.length,
    notesRead: agent.notesRead,
    iterations: agent.iterations,
    charsOffDevice: agent.charsOffDevice,
    end: agent.end?.kind ?? "finished",
  });
}

/**
 * Start an agent run **as a chat turn**: append the user's task (carrying the
 * scope it was sent under) plus the agent turn the run renders into, then drive
 * the first step.
 *
 * Resolves once that step settles. A run that stops to ask for more scope is a
 * settled step like any other. `AgentProgress` owns the dialog and the resume,
 * and the turn keeps rendering it, so there is no second entry point here.
 */
export async function startAgentRun(
  task: string,
  grant: ScopeGrant,
  copy: AgentRunCopy,
): Promise<void> {
  sendAgentTurn(task, copy.scopeLabel);
  beginRun();
  // Captured BEFORE the await, so a vault lock during the call invalidates what
  // comes back rather than being raced by it.
  const epoch = currentRunEpoch();
  try {
    settleRunIntoChat(await agentStart(task, grant), epoch);
  } catch {
    // Two stores, one failure, and both need it. `failRun` clears `running` and
    // records the message for a run that HAS a view; a start that never landed
    // has none, because `beginRun()` nulled it, so the progress strip does not
    // mount and `failAgentTurn` is what the user actually reads.
    failRun(copy.startFailed);
    failAgentTurn(copy.startFailed);
  }
}
