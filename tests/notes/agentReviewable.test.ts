// WHEN a run is the user's to review (myne-md/myne#894).
//
// **This is the predicate that used to live in `AgentReviewTakeover`, and the
// cases are that file's, kept one for one.** The surface changed, the review is
// a card inside the conversation rather than a dialog over it, but the question
// did not, and the two cases that had shipped wrong are both here:
//
//   - a run that stopped to ASK is not a run to review (`awaitingScope`), which
//     shipped as a review dialog opened over the scope dialog the user was
//     answering;
//   - a FAILED leg that left a proposal IS reviewable, which shipped as "it said
//     proposed changes and nothing came up" because the gate asked for an `end`
//     that `failRun` never writes.
//
// It is a pure store read now, so these run without a component, a transcript or
// a provider, and the surface that consumes it renders on the answer rather
// than acting on it in an effect, which is why the render-count test the old file
// carried has no equivalent here: there is nothing to mount and unmount.

import { afterEach, describe, expect, it } from "vitest";

import type { LoopEnd, Proposal } from "../../src/lib/agent-run";
import {
  beginAutoApply,
  beginRun,
  clearAgentForLock,
  currentRunEpoch,
  endAutoApply,
  failRun,
  getAgent,
  resumeRun,
  reviewableRun,
  settleApply,
  settleStep,
} from "../../src/notes/agent/agentStore";
import { applyOutcome } from "./_agentApplyOutcome";

const VIEW = {
  runId: "run-1",
  scopeTotal: 3,
  userGrants: 1,
  modelGrants: 0,
  cancelled: false,
};

/** One proposed edit, which is what makes a settled run reviewable at all.
 *
 *  The default rather than an empty proposal (myne-md/myne#568): the end-kind
 *  cases below are about the END, and giving them nothing to review would make
 *  them pass or fail on the other rule. */
const ONE_EDIT: Proposal = {
  edits: [{ noteId: "n1", anchor: "before", replacement: "after" }],
  newNotes: [],
  summary: "",
};

const NOTHING: Proposal = { edits: [], newNotes: [], summary: "" };

function settle(end: LoopEnd, proposal: Proposal = ONE_EDIT) {
  settleStep({
    view: VIEW,
    proposal,
    end,
    iterations: 1,
    notesRead: 1,
    charsOffDevice: null,
    excludedCount: 0,
    memoryUpdated: 0,
  }, currentRunEpoch());
}

afterEach(() => {
  clearAgentForLock();
});

describe("reviewableRun", () => {
  it("is null before a run has started", () => {
    expect(reviewableRun()).toBeNull();
  });

  it("is null while the run is still working", () => {
    beginRun(null);
    expect(reviewableRun()).toBeNull();
  });

  it("names the open run once it settled with something to show", () => {
    beginRun(null);
    settle({ kind: "finished" });
    expect(reviewableRun()).toEqual({ runId: "run-1" });
  });

  // The other direction, so the predicate cannot pass by refusing everything.
  // Each of these leaves a proposal the user is entitled to see, including a
  // partial one: a stalled run in particular can carry edits, and hiding those
  // would throw away work the user paid a provider for.
  for (const end of [
    { kind: "finished" } as const,
    { kind: "cancelled" } as const,
    { kind: "exhaustedIterations" } as const,
    { kind: "stalled", barrenIterations: 3 } as const,
  ]) {
    it(`opens for a run that ended ${end.kind}`, () => {
      beginRun(null);
      settle(end);
      expect(reviewableRun()).not.toBeNull();
    });
  }

  it("opens for a FAILED leg that left a proposal (myne-md/myne#848)", () => {
    // Leg 1 proposes and asks to widen the scope, the user approves (`resumeRun`
    // clears `end`, because the dialog derives its visibility from an
    // `awaitingScope` end), and the approved leg FAILS. `failRun` records `error`
    // and sets no `end`, so a gate asking for one never opens while edits sit in
    // the store.
    beginRun(null);
    settle({ kind: "awaitingScope", folder: "Projects", reason: "to find the notes" });
    resumeRun();
    failRun("the provider refused the request");
    expect(reviewableRun()).not.toBeNull();
  });

  it("stays closed when a failed leg left NOTHING to review", () => {
    // So the clause above cannot open the card over an empty proposal, which is
    // what every failed QUESTION leaves.
    beginRun(null);
    settle(
      { kind: "awaitingScope", folder: "Projects", reason: "to find the notes" },
      NOTHING,
    );
    resumeRun();
    failRun("the provider refused the request");
    expect(reviewableRun()).toBeNull();
  });

  it("does NOT open when the run stopped to ask for scope", () => {
    // The regression that shipped: an `awaitingScope` end is a question, not a
    // proposal, and the dialog that asks it renders underneath.
    beginRun(null);
    settle({ kind: "awaitingScope", folder: "Projects", reason: "why" });
    expect(reviewableRun()).toBeNull();
  });

  for (const end of [
    { kind: "finished" } as const,
    { kind: "cancelled" } as const,
    { kind: "exhaustedIterations" } as const,
    { kind: "stalled", barrenIterations: 3 } as const,
  ]) {
    it(`does NOT open when a ${end.kind} run proposed nothing`, () => {
      // myne-md/myne#568. Asking "how many tasks are in this note" is a run, so
      // "it stopped" and "there is something to review" are different facts; the
      // first version of the gate treated them as one and answered every question
      // with a review of an empty proposal.
      beginRun(null);
      settle(end, NOTHING);
      expect(reviewableRun()).toBeNull();
    });
  }

  it("opens for a proposal that is only new notes", () => {
    // The other half of the emptiness test, so it cannot be satisfied by looking
    // at `edits` alone: a run that proposed only new notes has as much to review
    // as one that proposed only edits.
    beginRun(null);
    settle(
      { kind: "finished" },
      { edits: [], newNotes: [{ title: "New", body: "body", folder: null }], summary: "" },
    );
    expect(reviewableRun()).not.toBeNull();
  });

  it("opens for a run that only changed a setting (myne-md/myne#850)", () => {
    // **The silent-drop gate.** Before settings, "the run proposed something" and
    // "the run proposed a note edit" were the same fact, and a gate left on the
    // old one does not error: the card simply never renders, so a change the
    // model made is never shown and nothing says why.
    beginRun(null);
    settle(
      { kind: "finished" },
      {
        edits: [],
        newNotes: [],
        settings: [{ intentId: "editor.weekly-notes-folder", value: "J/Weekly" }],
        summary: "",
      },
    );
    expect(reviewableRun()).not.toBeNull();
  });

  it("does NOT open for a summary alone, however long", () => {
    // A summary is an ANSWER, and the answer's home is the transcript. Pinned
    // separately because "there is text in the proposal" is the tempting wrong
    // condition: it would open the card for every question that got a wordy reply.
    beginRun(null);
    settle(
      { kind: "finished" },
      { edits: [], newNotes: [], summary: "You have 16 personal tasks." },
    );
    expect(reviewableRun()).toBeNull();
  });

  it("goes back to null once the run is dropped", () => {
    // Closing the card calls `clearAgent()`, which drops the run. That is what
    // makes the predicate false again; there is no second flag to unset.
    beginRun(null);
    settle({ kind: "finished" });
    expect(reviewableRun()).not.toBeNull();
    clearAgentForLock();
    expect(reviewableRun()).toBeNull();
  });

  it("never reports a run that is applying itself (myne-md/myne#551)", () => {
    // An automatic run would otherwise show the surface it exists to skip for the
    // frames between the step settling and the apply returning. `autoApplyRun`
    // calls `settleApply` and `endAutoApply` in one synchronous continuation, so
    // the state a caller can observe is the one below.
    beginRun(null);
    beginAutoApply();
    settle({ kind: "finished" });
    expect(reviewableRun()).toBeNull();

    settleApply(applyOutcome(), [0], currentRunEpoch());
    endAutoApply();
    expect(reviewableRun()).toBeNull();
  });

  it("is what makes a clean apply close the card", () => {
    // myne-md/myne#596, restated for the card: an apply that refused nothing and
    // left no row to act on has nothing left to decide, and `settleApply` drops
    // the run, so the predicate answers null and the card unmounts. Asserted on
    // the store, because "the card went away" is this fact at one remove.
    beginRun(null);
    settle({ kind: "finished" });
    expect(reviewableRun()).not.toBeNull();

    settleApply(applyOutcome(), [0], currentRunEpoch());

    expect(reviewableRun()).toBeNull();
    expect(getAgent().view).toBeNull();
    expect(getAgent().proposal.edits).toHaveLength(0);
  });

  it("drops the run rather than hiding it, so no proposal plaintext survives", () => {
    // The half a visibility assertion cannot see. `proposal.edits` holds anchors
    // and replacements copied verbatim out of note bodies, and the store's own
    // header exists to keep that from outliving the surface that showed it.
    beginRun(null);
    settle({ kind: "finished" });
    settleApply(applyOutcome(), [0], currentRunEpoch());
    expect(getAgent().proposal.edits).toHaveLength(0);
  });
});
