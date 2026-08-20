// @vitest-environment jsdom
//
// When the undo offer ends, and when it does not (myne-md/myne#533).
//
// `design-notes/ai/0515` states the lifetime exactly: "The offer therefore
// ends at the next apply or at vault lock, whichever comes first." The store
// disagreed with that in two places, and both were invisible because
// `UndoLastRun` re-reads the host whenever `applied` changes identity, which
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
};

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
    beginRun();
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
// verbatim out of note bodies. `design-notes/ai/0515` and `threat-model.md`
// §7 both say nothing an agent run holds survives a vault lock; without an
// epoch the reply simply landed afterwards and put that plaintext back.
describe("a step that lands after the vault was left", () => {
  it("is dropped rather than repopulating the store", () => {
    beginRun();
    const epoch = currentRunEpoch();
    // The lock happens while the host is still working.
    clearAgentForLock();
    expect(settleStep(STEP, epoch)).toBe(false);
    expect(state().view).toBeNull();
    expect(state().proposal.edits).toEqual([]);
  });

  it("still applies when no vault-leaving event happened", () => {
    // Non-vacuity: the guard must not be rejecting everything.
    beginRun();
    const epoch = currentRunEpoch();
    expect(settleStep(STEP, epoch)).toBe(true);
    expect(state().view?.runId).toBe("r2");
  });

  it("is dropped when the user starts a new conversation mid-run", () => {
    // The case with no host-side remedy: `beginRun()` nulls `view` and only a
    // settled step sets it, so for the whole first leg the run is working and
    // has no id to cancel with. Without the bump in `clearAgent` the reply
    // landed afterwards, put the proposal's verbatim anchors back, and made
    // `AgentReviewTakeover`'s derived `reviewable` true: a full-screen review
    // of a conversation the user had just deleted.
    beginRun();
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
