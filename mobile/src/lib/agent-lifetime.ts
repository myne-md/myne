// When a mobile agent run ends because the session did (myne-md/myne#456).
//
// **Three events, one function, and that is the whole design.** A lock, a vault
// switch and the app going to the background are different things to a user and
// the same thing to the store: each is a moment after which the run's proposal
// must not still be in memory. Writing the teardown once means a fourth such
// event inherits it instead of being a fourth place to forget.
//
// ## What is actually at risk
//
// `Proposal.edits` holds `anchor` and `replacement` strings the model copied
// VERBATIM out of note bodies. The store is module scope, so it outlives every
// unmount: leaving this screen is not what clears it, and must not be. Two
// specific costs, both recorded rather than hypothetical:
//
//   - A store that survives a LOCK leaves note text resident in a locked
//     vault's memory. `docs/decisions/ai/0515` rests its no-new-blob-family
//     argument on that text being RAM-only and dropped on lock, and
//     `docs/threat-model.md` says the same at AS1 and TB2.
//   - A store that survives a VAULT SWITCH mixes two vaults. Mobile's re-seed
//     is additive, which is exactly how myne-md/myne#454's three empty teardown
//     hooks put one vault's records on top of another's across Tasks, the
//     pickers, the graph, backlinks and every tag view.
//
// ## Backgrounding is the one that needs saying out loud
//
// On a phone the OS suspends a backgrounded WebView and may reclaim the process
// outright, so the reply to an in-flight `agentStart` can simply never arrive.
// Left alone that is a run which looks like it is still working, forever, over
// a provider that may still be being charged for it. So the run is CANCELLED
// host-side and the store is cleared, and the user is TOLD: coming back to a
// screen that silently shows nothing reads as a crash, and coming back to one
// still saying "Working" is worse, because it is false.
//
// The notice is set AFTER the clear, deliberately. `clearAgentForLock` bumps the
// run epoch, so a reply that lands later is dropped rather than repopulating the
// store; setting the notice first would have it wiped by the very call that
// makes it true.

import { clearAgentForLock, failRun, getAgent } from "@myne/agent-store";

import { agentCancel } from "./agent-run";

/** Why the run ended, which decides whether anyone is left to read a notice. */
export type AgentEndReason =
  /** The vault was locked or switched. Both go through mobile's single
   *  `lockVault` choke point, and after either the user is on the unlock
   *  screen: there is no surface left to show a notice on, and the run's own
   *  end is not the news. */
  | "lock"
  /** The app went to the background. The session continues, so the user comes
   *  back to this screen and is owed an explanation for the empty one. */
  | "background";

/**
 * Cancel any in-flight run and drop everything the store holds about it.
 *
 * Safe to call when no run is open: the cancel is skipped and the clear is a
 * no-op over an already-empty store. That matters because the callers are
 * lifecycle hooks, not the agent surface, and they fire whether or not anybody
 * has ever opened the AI tab.
 *
 * The host cancel is best-effort and deliberately not awaited by the lock path:
 * `lockVault` drops the slot immediately afterwards, which ends the run anyway,
 * and blocking a lock on a network-adjacent call would be the wrong trade.
 */
export function endAgentRun(reason: AgentEndReason, cancelledNotice: string): void {
  const state = getAgent();
  const idle =
    state.view === null &&
    !state.running &&
    state.end === null &&
    state.undoable === null &&
    state.error === null;
  const runId = state.view?.runId ?? null;
  // The id may genuinely be absent: the window between starting a run and the
  // host's first message is real, and a start that failed outright never had a
  // view. The clear below is what covers that case.
  if (runId !== null) {
    void agentCancel(runId).catch(() => {
      // A failed cancel changes nothing here. The store is cleared regardless,
      // and on the lock path the slot is about to drop anyway.
    });
  }
  // **Always, even when the store looks idle.** An earlier version returned
  // early on that state to save three store rebuilds per app switch, and it
  // skipped the three fields `clearAgentForLock` clears BEYOND `clearAgent`:
  // `autoApply`, `autoApplying` and `probeVerdict`. Those are exactly what
  // separates the lock variant from closing a screen. Carrying `autoApply`
  // across a lock lets a run write into a vault the user did not choose it for,
  // and a carried `probeVerdict` gates agent mode on a measurement of a backend
  // that is no longer in use. The call is a no-op over an already-empty store,
  // so the saving was three notifications and the cost was a rule.
  clearAgentForLock();
  // The notice is for a run that was actually going. Left on an idle store it
  // would tell somebody their run was cancelled because they switched apps,
  // about a run that never existed.
  if (reason === "background" && !idle) failRun(cancelledNotice);
}
