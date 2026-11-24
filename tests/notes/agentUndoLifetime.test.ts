// @vitest-environment jsdom
//
// When the undo offer ends, and when it does not (myne-md/myne#533).
//
// `decisions/ai/0515` states the lifetime exactly: "The offer therefore
// ends at the next apply or at vault lock, whichever comes first." The store
// disagreed with that in two places, and both were invisible because
// `useUndoLastRun` re-reads the host whenever `applied` changes identity, which
// masks the drop in the one sequence anybody tests by hand (apply, then close
// the review) and not in the one that matters (apply run A, then start run B).
//
// `beginRun` and `clearAgent` spread `INITIAL` wholesale, so both nulled
// `undoable`. That also made `clearAgentForLock`, a function whose entire
// reason for existing is to null it, and which
// `scripts/check-frontend-lock-teardown.mjs` asserts on every vault-leaving
// path, behave identically to `clearAgent`. A distinction the code documents
// twice and does not make is worse than no distinction: the guard passes, the
// comment reassures, and the two events are the same event.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

import {
  beginRun,
  clearAgent,
  clearAgentForLock,
  currentRunEpoch,
  setUndoable,
  settleApply,
  settleStep,
  useAgent,
} from "../../src/notes/agent/agentStore";

/** The host's record of a run that could still be undone. */
const RUN = {
  runId: "r1",
  restorePoints: [["n1", "s1"]] as [string, string][],
  notesCreated: 0,
};

const STEP = {
  view: { runId: "r2", scopeTotal: 1, userGrants: 1, modelGrants: 0, cancelled: false },
  proposal: { edits: [], newNotes: [], summary: "" },
  end: { kind: "finished" as const },
  iterations: 1,
  notesRead: 1,
  charsOffDevice: null,
  excludedCount: 0,
memoryUpdated: 0,};

beforeEach(() => {
  clearAgentForLock();
});
afterEach(() => {
  cleanup();
  clearAgentForLock();
});

/** The store as a component sees it. */
function state() {
  return renderHook(() => useAgent()).result.current;
}

describe("the undo offer's lifetime", () => {
  it("survives a second run being started", () => {
    setUndoable(RUN, currentRunEpoch());
    beginRun(null);
    // Starting a run is not applying one. The host still holds the record, and
    // before this the surface stopped offering it.
    expect(state().undoable).toEqual(RUN);
  });

  it("survives the review screen being closed", () => {
    setUndoable(RUN, currentRunEpoch());
    settleStep(STEP, currentRunEpoch());
    clearAgent();
    // Closing the screen ends the PROPOSAL. The applied notes are still applied.
    expect(state().undoable).toEqual(RUN);
    // …and it really did end the proposal, so this is not passing by doing
    // nothing at all.
    expect(state().view).toBeNull();
    expect(state().proposal.edits).toEqual([]);
  });

  it("ends at the vault lock, which is what makes the two clears different", () => {
    setUndoable(RUN, currentRunEpoch());
    clearAgentForLock();
    // The record names note ids of a vault that is no longer open, and the host
    // has cleared its own copy by the same event.
    expect(state().undoable).toBeNull();
  });
});

// A step in flight outlives the lock that was supposed to end the run, and its
// reply carries a `Proposal` whose edits hold anchors and replacements copied
// verbatim out of note bodies. `decisions/ai/0515` and `threat-model.md`
// §7 both say nothing an agent run holds survives a vault lock; without an
// epoch the reply simply landed afterwards and put that plaintext back.
describe("a step that lands after the vault was left", () => {
  it("is dropped rather than repopulating the store", () => {
    beginRun(null);
    const epoch = currentRunEpoch();
    // The lock happens while the host is still working.
    clearAgentForLock();
    expect(settleStep(STEP, epoch)).toBe(false);
    expect(state().view).toBeNull();
    expect(state().proposal.edits).toEqual([]);
  });

  it("still applies when no vault-leaving event happened", () => {
    // Non-vacuity: the guard must not be rejecting everything.
    beginRun(null);
    const epoch = currentRunEpoch();
    expect(settleStep(STEP, epoch)).toBe(true);
    expect(state().view?.runId).toBe("r2");
  });

  it("is dropped when the user starts a new conversation mid-run", () => {
    // The case with no host-side remedy: `beginRun(null)` nulls `view` and only a
    // settled step sets it, so for the whole first leg the run is working and
    // has no id to cancel with. Without the bump in `clearAgent` the reply
    // landed afterwards, put the proposal's verbatim anchors back, and opened a
    // review card over a conversation the user had just deleted.
    beginRun(null);
    const epoch = currentRunEpoch();
    clearAgent();
    expect(settleStep(STEP, epoch)).toBe(false);
    expect(state().view).toBeNull();
    expect(state().proposal.edits).toEqual([]);
  });

  it("does not let a stale undo record re-seed the offer after a lock", () => {
    // `AppliedRun.restorePoints` names note ids of the vault it describes, and
    // `agentLastRun()` is awaited. Before this the offer was protected only by
    // the strip's unmount, which is a rendering fact rather than a guarantee.
    const epoch = currentRunEpoch();
    clearAgentForLock();
    setUndoable(RUN, epoch);
    expect(state().undoable).toBeNull();
    // Clearing is always allowed: dropping the offer is never the unsafe
    // direction, so a stale `null` must still land.
    setUndoable(RUN, currentRunEpoch());
    setUndoable(null, epoch);
    expect(state().undoable).toBeNull();
  });
});

// ---- a second run invalidates the first run's in-flight legs -----------------
//
// The epoch's own note names a lock, a vault switch and "New chat". Starting a
// second RUN is the same class and was not covered, and the only other guard is
// `ChatComposer`'s `busy`, which is component state: `AiChatTab` mounts
// conditionally on the right panel's active tab, so switching that tab away and
// back remounts the composer with `busy` false while run one is still in
// flight.
//
// What that cost is not cosmetic. `settleStep` ACCUMULATES `iterations`,
// `notesRead` and `charsOffDevice`, so run one's reply added its totals to run
// two's freshly zeroed counters and `settleRunIntoChat` froze the merged
// figures onto run two's turn. `charsOffDevice` is the disclosure figure
// `decisions/ai/0515` names as the compensating control for the uncapped
// remote arm, so a merged total is a false statement about how much of the
// user's text left the device.
describe("a second run invalidates the first run's in-flight legs", () => {
  it("drops the first run's step after a second run has started", () => {
    beginRun(null);
    const first = currentRunEpoch();
    beginRun(null);
    expect(settleStep(STEP, first)).toBe(false);
  });

  it("leaves the second run's counters untouched by the first run's step", () => {
    // The assertion that matters is the STATE, not the return value: a version
    // that returned false and wrote anyway would satisfy the case above.
    beginRun(null);
    const first = currentRunEpoch();
    beginRun(null);
    const second = currentRunEpoch();
    settleStep({ ...STEP, iterations: 7, notesRead: 5, charsOffDevice: 4000 }, first);
    expect(state().iterations).toBe(0);
    expect(state().notesRead).toBe(0);
    expect(state().charsOffDevice).toBeNull();
    // ...and the live run still settles normally, so the guard did not simply
    // stop the store working.
    expect(settleStep(STEP, second)).toBe(true);
    expect(state().iterations).toBe(1);
  });

  it("still lets the run that is actually live settle", () => {
    beginRun(null);
    expect(settleStep(STEP, currentRunEpoch())).toBe(true);
    expect(state().view).toEqual(STEP.view);
  });
});

// ---- the apply outcome is epoch-guarded too ----------------------------------
//
// `AgentApplyResult` carries `notesWritten`, `notesCreated` and `restorePoints`,
// which are note ids of the vault it describes, and `agentApply` is awaited.
// `setUndoable` was given an epoch for exactly this data class and this writer
// was left out, so `clearAgentForLock`'s claim that "a reply that lands after
// the teardown cannot repopulate the store" was false through this one call
// site.
const APPLY = {
  applied: 1,
  refused: [],
  refusedNewNotes: [],
  notesWritten: ["n1"],
  notesCreated: [],
  restorePoints: [["n1", "s1"]] as [string, string][],
};

describe("an apply outcome that lands after the vault was left", () => {
  it("is dropped rather than written into the store", () => {
    beginRun(null);
    const epoch = currentRunEpoch();
    clearAgentForLock();
    expect(settleApply(APPLY, [0], epoch)).toBe(false);
    expect(state().applied).toBeNull();
    expect(state().appliedEdits.size).toBe(0);
  });

  it("is dropped after a second run has started", () => {
    beginRun(null);
    const epoch = currentRunEpoch();
    beginRun(null);
    expect(settleApply(APPLY, [0], epoch)).toBe(false);
    expect(state().applied).toBeNull();
  });

  it("lands while the run it belongs to is still the live one", () => {
    beginRun(null);
    expect(settleApply(APPLY, [0], currentRunEpoch())).toBe(true);
    expect(state().applied?.notesWritten).toEqual(["n1"]);
    expect(state().appliedEdits.has(0)).toBe(true);
  });
});
