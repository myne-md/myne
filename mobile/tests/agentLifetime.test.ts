// @vitest-environment jsdom
//
// The mobile agent run's lifetime (myne-md/myne#456 task 14).
//
// **Asserted on the resulting STATE, never on a return value.** `endAgentRun`
// returns nothing, and that is deliberate: a teardown that reported success
// would invite a test asserting the report instead of the effect, which is the
// weaker fact. What is checked here is that the store is EMPTY afterwards, one
// field at a time for the fields that hold note text.
//
// `scripts/check-frontend-lock-teardown.mjs` is the structural half and it
// checks the two hops (the path calls the wrapper, the wrapper calls the
// clear). It cannot check BEHAVIOUR: deleting the epoch bump inside
// `clearAgentForLock` leaves that guard green. This file is that half.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  currentRunEpoch,
  getAgent,
  openRun,
  settleStep,
} from "@myne/agent-store";
import type { AgentRunView } from "@myne/agent-protocol";

import { agentCancel, agentRunModule, resetAgentRunMock } from "./helpers/agentRunMock";

vi.mock("../src/lib/agent-run", () => agentRunModule());

const { endAgentRun } = await import("../src/lib/agent-lifetime");

const VIEW: AgentRunView = { runId: "run-1", scopeTotal: 5 };

/** A settled run holding text copied out of a note body, which is the thing
 *  none of these events may leave behind. */
function seedRun() {
  settleStep(
    {
      view: VIEW,
      proposal: {
        edits: [
          {
            noteId: "n1",
            anchor: "the sentence from the user's note",
            replacement: "a rewritten sentence",
          },
        ],
        newNotes: [],
        summary: "Rewrote one passage.",
      },
      end: { kind: "finished" },
      iterations: 3,
      notesRead: 7,
      charsOffDevice: 9000,
      excludedCount: 0,
    },
    currentRunEpoch(),
  );
}

beforeEach(() => {
  resetAgentRunMock();
  agentCancel.mockResolvedValue(true);
  endAgentRun("lock", "");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("endAgentRun", () => {
  it("leaves no note-derived text behind, whichever event ended the run", () => {
    for (const reason of ["lock", "background"] as const) {
      seedRun();
      // The precondition, so a green result cannot mean "the store was already
      // empty". A teardown test that never seeds anything passes forever.
      expect(getAgent().proposal.edits).toHaveLength(1);

      endAgentRun(reason, "cancelled");

      const s = getAgent();
      expect(s.proposal.edits).toHaveLength(0);
      expect(s.proposal.newNotes).toHaveLength(0);
      expect(s.proposal.summary).toBe("");
      expect(s.view).toBeNull();
      expect(s.end).toBeNull();
    }
  });

  it("cancels the run host-side, not only in the store", () => {
    // The half that matters off-device. A cleared store with a run still
    // spending on a provider is the worse half of the failure: the user cannot
    // see it and it is still being charged for.
    seedRun();
    openRun(VIEW, currentRunEpoch());

    endAgentRun("background", "cancelled");

    expect(agentCancel).toHaveBeenCalledWith("run-1");
  });

  it("is safe when no run was ever opened", () => {
    // The callers are lifecycle hooks, not the agent surface: they fire whether
    // or not anybody has opened the AI tab. A teardown that threw on an empty
    // store would break locking the vault for every user who never used AI.
    expect(() => endAgentRun("lock", "")).not.toThrow();
    expect(agentCancel).not.toHaveBeenCalled();
  });

  it("drops a reply that lands after the teardown", () => {
    // The epoch, asserted through its EFFECT rather than by reading the number.
    // A run in flight when the vault is left would otherwise repopulate a
    // module-scope store with anchors and replacements from a vault that is no
    // longer open.
    seedRun();
    const epochBefore = currentRunEpoch();
    endAgentRun("lock", "");

    const landed = settleStep(
      {
        view: VIEW,
        proposal: {
          edits: [{ noteId: "n1", anchor: "late text", replacement: "later text" }],
          newNotes: [],
          summary: "late",
        },
        end: { kind: "finished" },
        iterations: 1,
        notesRead: 1,
        charsOffDevice: 10,
        excludedCount: 0,
      },
      epochBefore,
    );

    expect(landed).toBe(false);
    expect(getAgent().proposal.edits).toHaveLength(0);
  });

  it("tells the user a BACKGROUNDED run was cancelled", () => {
    // The user comes back to this screen, so an empty one with no explanation
    // reads as a crash and one still saying "Working" is worse, because it is
    // false.
    seedRun();
    endAgentRun("background", "the run was cancelled");

    const s = getAgent();
    expect(s.error).toBe("the run was cancelled");
    expect(s.running).toBe(false);
  });

  it("says nothing on a LOCK, because there is nobody to say it to", () => {
    // After a lock or a switch the user is on the unlock screen. A notice for a
    // surface that is gone is a message left in a store, and the store is the
    // thing this call exists to empty.
    seedRun();
    endAgentRun("lock", "the run was cancelled");
    expect(getAgent().error).toBeNull();
  });
});
