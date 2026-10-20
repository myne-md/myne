// Which turn renders the review card (myne-md/myne#894).
//
// Pure, and it is a pure function precisely because both directions matter and
// both are reachable: a card under the wrong message is a proposal read next to a
// request it has nothing to do with, and the next thing the reader does is
// approve it.

import { describe, expect, it } from "vitest";

import { reviewCardBelongsToTurn } from "../../src/notes/ai/reviewOwnership";

describe("reviewCardBelongsToTurn", () => {
  it("is the frozen turn that names the run", () => {
    expect(reviewCardBelongsToTurn("t2", "run-1", "t2", "run-1")).toBe(true);
  });

  it("is not a turn whose summary names a DIFFERENT run", () => {
    // The case a stale card would produce: the user has moved on to another run,
    // and the older turn must not claim the open one.
    expect(reviewCardBelongsToTurn("t1", "run-0", "t2", "run-1")).toBe(false);
  });

  it("is the live turn while nothing is frozen onto any turn yet", () => {
    // The frames between `settleStep` writing the store and `AGENT_SETTLE`
    // writing the turn: there is no id to match, so the newest agent turn, the
    // one a live run renders into, is the claim.
    expect(reviewCardBelongsToTurn("t2", undefined, "t2", "run-1")).toBe(true);
  });

  it("is not a turn that is neither live nor frozen onto the run", () => {
    expect(reviewCardBelongsToTurn("t1", undefined, "t2", "run-1")).toBe(false);
  });

  it("is nobody when there is no live agent turn at all", () => {
    // A cold transcript: the store may hold a run from another conversation, and
    // no turn in this one may show it.
    expect(reviewCardBelongsToTurn("t1", undefined, null, "run-1")).toBe(false);
  });

  it("prefers the frozen id over the live slot, so an older turn keeps its card", () => {
    // Both facts present and disagreeing: a new run started while an older turn
    // still holds an unapplied proposal. The frozen turn is the one the run
    // belongs to, and the live slot is about the NEW run.
    expect(reviewCardBelongsToTurn("t1", "run-1", "t2", "run-1")).toBe(true);
    expect(reviewCardBelongsToTurn("t2", "run-2", "t2", "run-1")).toBe(false);
  });
});
