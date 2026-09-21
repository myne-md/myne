// When a finished run has nothing left to say (myne-md/myne#596).
//
// The review dialog used to sit there after a clean apply until the user
// dismissed it by hand: nothing refused, no row left to act on, and a
// full-screen modal over the editor with no decision left in it.
//
// **Asserted on the STORE, not on the predicate's return value.** `settleApply`
// consumes `applyWasCleanAndComplete` and drops the run when it holds, so the
// observable contract is "the run is gone" or "the run is still here", and a
// test that asked the predicate afterwards would be asking an emptied store.
// Assertion on the state rather than on a return value is also what `AGENTS.md`
// asks for wherever both are available.
//
// **An APPLY is the only thing that closes the review, and several cases here
// exist to keep it that way.** The rule was first written as a `useEffect`
// deriving from state, which reached a rejection: one click on the last
// outstanding row's Reject button dropped the whole proposal, with no
// confirmation, from the control whose other direction is labelled Restore.
// `a rejection alone never closes the review` is that case.
//
// Driven through the public store surface so the wiring under test is the same
// one the dialog reads.

import { afterEach, describe, expect, it } from "vitest";

import type { Proposal } from "../../src/lib/agent-run";
import { applyOutcome } from "./_agentApplyOutcome";
import {
  beginRun,
  clearAgentForLock,
  currentRunEpoch,
  failRun,
  getAgent,
  settleApply,
  settleStep,
  toggleEdit,
  toggleNewNote,
} from "../../src/notes/agent/agentStore";

const VIEW = {
  runId: "run-1",
  scopeTotal: 1,
  userGrants: 1,
  modelGrants: 0,
  cancelled: false,
};

function edit(n: number) {
  return { noteId: `n${n}`, anchor: `before-${n}`, replacement: `after-${n}` };
}

function newNote(title: string) {
  return { title, body: "b", folder: null };
}

function settle(proposal: Proposal) {
  beginRun();
  settleStep(
    {
      view: VIEW,
      proposal,
      end: { kind: "finished" },
      iterations: 1,
      notesRead: 1,
      charsOffDevice: null,
      excludedCount: 0,
    memoryUpdated: 0,},
    currentRunEpoch(),
  );
}

/** Whether the run survived. `view` is what `AgentReviewTakeover` renders on. */
function runIsOpen(): boolean {
  return getAgent().view !== null;
}

afterEach(() => {
  clearAgentForLock();
});

describe("a clean, complete apply drops the run", () => {
  it("drops it when every edit landed and nothing was refused", () => {
    settle({ edits: [edit(1)], newNotes: [], summary: "" });
    settleApply(applyOutcome(), [0], currentRunEpoch());
    expect(runIsOpen()).toBe(false);
    // The proposal goes with it, which is the half a visibility check cannot
    // see: `proposal.edits` holds anchors and replacements copied verbatim out
    // of note bodies.
    expect(getAgent().proposal.edits).toHaveLength(0);
  });

  it("still moves the apply counter, so the undo strip re-reads the host", () => {
    // **The regression the E2E caught and nothing else would have.**
    // `UndoLastRun` re-reads the host's undo record in an effect keyed on this
    // counter. When the close was made atomic with the settle, `applied` was
    // written and nulled inside one `settleApply` call, so React's store
    // subscription only ever saw the final state: the old key (`applied
    // ?.applied`) read 0 to 0, the effect never fired, `agentLastRun()` was
    // never called, and the undo offer never appeared after exactly the applies
    // it exists for. ag1 and ag4 failed on `agentUndoLast.root` for three
    // consecutive runs; that suite is manual and pre-release, so this is the
    // gate that has to hold it.
    settle({ edits: [edit(1)], newNotes: [], summary: "" });
    const before = getAgent().applySeq;
    settleApply(applyOutcome(), [0], currentRunEpoch());
    expect(runIsOpen(), "the run was dropped, which is the point").toBe(false);
    expect(getAgent().applySeq, "the counter survives the drop").toBe(before + 1);
  });

  it("counts an edit the user rejected as resolved", () => {
    // Rejecting IS deciding, so a rejected row does not hold the screen. This
    // is the shape ag1 drives: reject one, approve the rest.
    settle({ edits: [edit(1), edit(2)], newNotes: [], summary: "" });
    toggleEdit(1);
    settleApply(applyOutcome(), [0], currentRunEpoch());
    expect(runIsOpen()).toBe(false);
  });
});

describe("what keeps the review open", () => {
  it("a rejection alone never closes it, however little is left", () => {
    // **The defect that moved this rule out of the view.** Apply one row
    // cleanly, leave the other outstanding, then reject the outstanding one:
    // every row is now resolved and nothing was refused, so a state-derived
    // rule would fire here and destroy the proposal on a button press the UI
    // advertises as reversible. Only an apply may close the review.
    settle({ edits: [edit(1), edit(2)], newNotes: [], summary: "" });
    settleApply(applyOutcome(), [0], currentRunEpoch());
    expect(runIsOpen(), "one row is still outstanding").toBe(true);

    toggleEdit(1);

    expect(runIsOpen()).toBe(true);
    expect(getAgent().proposal.edits).toHaveLength(2);
  });

  it("an edit that is neither rejected nor applied", () => {
    settle({ edits: [edit(1), edit(2)], newNotes: [], summary: "" });
    settleApply(applyOutcome(), [0], currentRunEpoch());
    expect(runIsOpen()).toBe(true);
  });

  it("a refusal, even once its row has been resolved and a later apply completes", () => {
    // **The refusal clause, isolated.** A refused edit is not in `appliedEdits`
    // so it stays in `keptEdits`, which means the obvious test for a refusal
    // answers on the completeness clause instead and stays green with the
    // refusal check deleted. Measured on the first draft of this file. So the
    // refused row is REJECTED and a later apply completes everything: nothing
    // is outstanding, and the accumulated refusal is the only thing left
    // holding the screen.
    settle({ edits: [edit(1), edit(2), edit(3)], newNotes: [], summary: "" });
    settleApply(
      applyOutcome({
        applied: 1,
        refused: [{ noteId: "n2", index: 1, reason: "anchorAmbiguous" }],
      }),
      [0],
      currentRunEpoch(),
    );
    toggleEdit(1);
    expect(runIsOpen(), "edit 2 is still outstanding").toBe(true);

    settleApply(applyOutcome({ applied: 1 }), [2], currentRunEpoch());

    expect(runIsOpen()).toBe(true);
  });

  it("a refused new note", () => {
    settle({ edits: [], newNotes: [newNote("t")], summary: "" });
    settleApply(
      applyOutcome({
        applied: 0,
        notesWritten: [],
        restorePoints: [],
        refusedNewNotes: [{ index: 0, reason: "outOfScope" }],
      }),
      [],
      currentRunEpoch(),
    );
    expect(runIsOpen()).toBe(true);
  });

  it("a whole-call apply failure, so its message is still readable", () => {
    // `failRun` writes the only signal the user has that a write they asked for
    // did not happen, and `clearAgent` nulls it along with the run. Both
    // surfaces that render it go with the run too.
    settle({ edits: [edit(1)], newNotes: [], summary: "" });
    failRun("Applying failed");
    settleApply(applyOutcome(), [0], currentRunEpoch());
    expect(runIsOpen()).toBe(true);
    expect(getAgent().error).toBe("Applying failed");
  });

  it("a new note that was created", () => {
    // A create has no restore point, and `agentReview.createdCount` is the only
    // surface in the client that reports one. Closing over it destroys the
    // single report of the least reversible thing an agent run does.
    settle({ edits: [], newNotes: [newNote("t")], summary: "" });
    settleApply(
      applyOutcome({
        applied: 0,
        notesWritten: [],
        restorePoints: [],
        notesCreated: ["created-1"],
      }),
      [],
      currentRunEpoch(),
    );
    expect(runIsOpen()).toBe(true);
  });

  it("an approved new note that was not created", () => {
    // `onApplyOne` always sends an empty new-note list, so this is what a
    // per-row apply leaves behind on a proposal carrying new notes.
    settle({ edits: [edit(1)], newNotes: [newNote("t")], summary: "" });
    settleApply(applyOutcome(), [0], currentRunEpoch());
    expect(runIsOpen()).toBe(true);
  });

});

describe("a new note the user rejected and nothing created", () => {
  it("does not hold the review open, because it left nothing behind", () => {
    // The one new-note case that DOES close, and it is the boundary of the
    // clause above: no note is approved and waiting, and none was created, so
    // there is neither a pending write nor an unreversible one to report.
    // Asserted so the clause reads as "new notes that still matter" rather than
    // "new notes at all", which is what the code does and what its comment has
    // to say.
    settle({ edits: [edit(1)], newNotes: [newNote("t")], summary: "" });
    toggleNewNote(0);
    settleApply(applyOutcome(), [0], currentRunEpoch());
    expect(runIsOpen()).toBe(false);
  });
});

describe("a run with no apply is not finished", () => {
  it("stays open however it ended", () => {
    // The non-vacuity floor for every case above: a settled run with a good
    // proposal is waiting, not finished.
    settle({ edits: [edit(1)], newNotes: [], summary: "" });
    expect(runIsOpen()).toBe(true);
  });

  it("stays open when it proposed nothing at all", () => {
    // An empty proposal satisfies "no unresolved row" trivially, so without the
    // `applied === null` arm it would read as finished. (The dialog does not
    // open for it either way, per myne-md/myne#568; what this pins is that the
    // run is not silently dropped.)
    settle({ edits: [], newNotes: [], summary: "nothing to change" });
    expect(runIsOpen()).toBe(true);
  });

  it("survives an apply that lands against an empty proposal", () => {
    // Nothing to review means there is no review to close. Unreachable in
    // production, because both apply paths return early on an empty payload,
    // but the store's contract is that an outcome landing while its run is live
    // is WRITTEN, and dropping the run here silently voided that
    // (`tests/notes/agentUndoLifetime.test.ts` caught it).
    settle({ edits: [], newNotes: [], summary: "" });
    settleApply(applyOutcome(), [0], currentRunEpoch());
    expect(runIsOpen()).toBe(true);
    expect(getAgent().applied?.notesWritten).toEqual(["n1"]);
  });
});
