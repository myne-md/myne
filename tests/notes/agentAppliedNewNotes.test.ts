// A refused CREATE must stay actionable (myne-md/myne#913, review round three).
//
// The store tracked applied edits and applied settings but not applied new
// notes, so a note the host had written stayed in the actionable set and the
// card offered "Approve 1 change" beside "2 changes applied". The first fix
// added `appliedNewNotes` but handed `settleApply` the indices it SENT rather
// than the ones that LANDED, so a create the host REFUSED (an unsafe title, an
// excluded folder, a write failure) was recorded as done: its row read
// "Created", its Reject control disappeared, and that note could never be
// created for the rest of the run.
//
// **Asserted through the public store surface, after an apply**, because the
// pure helper is already covered in `agentAppliedIndices.test.ts` and the defect
// was at the call site: a test of the helper alone stays green when the call
// site passes the wrong list.

import { afterEach, describe, expect, it } from "vitest";

import type { Proposal } from "../../src/lib/agent-run";
import { applyOutcome } from "./_agentApplyOutcome";
import {
  approvedNewNoteIndices,
  beginRun,
  clearAgentForLock,
  currentRunEpoch,
  getAgent,
  landedNewNoteIndices,
  settleApply,
  settleStep,
} from "../../src/notes/agent/agentStore";

const VIEW = {
  runId: "run-1",
  scopeTotal: 1,
  userGrants: 1,
  modelGrants: 0,
  cancelled: false,
};

function newNote(title: string) {
  return { title, body: "b", folder: null };
}

function settle(proposal: Proposal) {
  beginRun(null);
  settleStep(
    {
      view: VIEW,
      proposal,
      end: { kind: "finished" },
      iterations: 1,
      notesRead: 1,
      charsOffDevice: null,
      excludedCount: 0,
      memoryUpdated: 0,
    },
    currentRunEpoch(),
  );
}

afterEach(() => {
  clearAgentForLock();
});

describe("a refused create stays in the actionable set", () => {
  it("marks only the landed create as applied", () => {
    settle({ edits: [], newNotes: [newNote("one"), newNote("two")], summary: "" });
    const sent = approvedNewNoteIndices();
    expect(sent).toEqual([0, 1]);

    // The host refused the SECOND create. That is the shape `agentApply` really
    // returns: `refusedNewNotes[].index` is a proposal position.
    const outcome = applyOutcome({
      applied: 1,
      refusedNewNotes: [{ index: 1, reason: "unsafeFrontmatter" }],
      notesCreated: ["new-one"],
    });
    settleApply(outcome, [], currentRunEpoch(), [], landedNewNoteIndices(sent, outcome));

    // The refused one is still offered, so the user can approve it again; the
    // landed one is not, so the count in the footer matches what is left to do.
    expect(approvedNewNoteIndices()).toEqual([1]);
    expect(getAgent().appliedNewNotes.has(0)).toBe(true);
    expect(getAgent().appliedNewNotes.has(1)).toBe(false);
  });

  it("drops both from the actionable set when both landed", () => {
    settle({ edits: [], newNotes: [newNote("one"), newNote("two")], summary: "" });
    const sent = approvedNewNoteIndices();
    const outcome = applyOutcome({
      applied: 2,
      refusedNewNotes: [],
      notesCreated: ["new-one", "new-two"],
    });
    settleApply(outcome, [], currentRunEpoch(), [], landedNewNoteIndices(sent, outcome));
    expect(approvedNewNoteIndices()).toEqual([]);
  });
});
