// Which transcript turn owns the review card (myne-md/myne#894).
//
// The card is rendered by the assistant turn that proposed the run, so ONE
// question has to be answered per turn: is the open run mine? Getting it wrong is
// not a cosmetic bug, a card under the wrong message is a proposal the user
// reads next to a request it has nothing to do with, and the failure mode after
// it is worse, because the next thing they do is approve it.
//
// Two shapes reach this, and both are real:
//
//   - **Frozen.** The run settled and `AGENT_SETTLE` froze its summary onto the
//     turn, which carries the `runId`. This is the ordinary case: the store still
//     holds the run (the user has not applied or discarded it), and the turn that
//     names that run is the one that must show it.
//   - **Live.** The frames between `settleStep` writing the store and
//     `AGENT_SETTLE` writing the turn. The turn has no summary yet, so there is
//     no id to match; the turn the store's run renders into is the newest agent
//     turn, which is what `liveAgentTurnId` names.
//
// Pure, so both directions are testable without a transcript, a store or a
// provider. `ConversationSurface` passes the three facts it already holds.

/**
 * Whether the review card belongs to one transcript turn.
 *
 * @param turnId the turn being rendered
 * @param frozenRunId the run id frozen onto that turn's summary, or `undefined`
 *   when nothing has been frozen onto it yet
 * @param liveAgentTurnId the newest assistant agent turn, the one a live run
 *   renders into, or `null` when there is none
 * @param openRunId the run the review is about (`reviewableRun`'s answer)
 */
export function reviewCardBelongsToTurn(
  turnId: string,
  frozenRunId: string | undefined,
  liveAgentTurnId: string | null,
  openRunId: string,
): boolean {
  if (frozenRunId !== undefined) return frozenRunId === openRunId;
  // Nothing frozen yet: the run can only be the one rendering into the newest
  // agent turn. A turn that is not that one has no claim on it.
  return liveAgentTurnId !== null && turnId === liveAgentTurnId;
}
