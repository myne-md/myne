// Starting a fresh conversation, as one act (myne-md/myne#771).
//
// ── The defect this closes ─────────────────────────────────────────────────
// The agent hub's "New conversation" wrote the workspace state and nothing
// else — so the tab forgot which conversation it was showing while the CHAT
// STORE went on holding the previous transcript, and the screen did not
// change. A button that looks like it did nothing, because it did almost
// nothing.
//
// The light panel's "New chat" had the whole sequence, three steps deep with a
// recorded reason for the ordering. Copying it into the hub would have been a
// second copy of a sequence whose ordering is load-bearing, which is how one of
// them loses a step.
//
// ── The order is the reason this is a function ─────────────────────────────
// **Stop what you are clearing, host side, before clearing it.** Forgetting a
// run is not stopping one: an abandoned run still settles later through
// `settleRunIntoChat`, which repopulates the store and pops the review of a
// conversation the user has just walked away from. `clearAgent()` bumps the run
// epoch, so a late reply is dropped instead of repopulating the store — but
// only if the cancel went out first.
//
// And it is `clearAgent()`, NOT `clearAgentForLock()`. The undo offer describes
// notes already written to the vault, and starting a new conversation does not
// un-write them.

import { agentCancel } from "../../lib/agent-run";
import { clearAgent, getAgent } from "../agent/agentStore";
import { clearChat } from "./chatStore";

/**
 * Clear the open transcript and the open run, so the next message starts a new
 * conversation.
 *
 * Reads the run from the store rather than taking it as an argument: every
 * caller would otherwise have to hold a subscription for a value it only needs
 * at the moment of the click, and a caller that got it wrong would leave a run
 * alive with nothing pointing at it.
 */
export function startNewConversation(): void {
  const view = getAgent().view;
  if (view !== null) void agentCancel(view.runId);
  clearChat();
  clearAgent();
}
