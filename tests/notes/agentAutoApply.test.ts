// @vitest-environment jsdom
//
// Automatic apply, and the three bounds `docs/threat-model.md` rests on
// (myne-md/myne#551).
//
// This mode is a change to a normative guarantee: SYNC-17 says the AI never
// writes to a note without an explicit user action, and its 2026-08-16
// restatement defined that action as the per-edit approval on the review
// screen. The reason is prompt injection rather than data loss, so the bounds
// are the whole of what makes the new form of the guarantee true, and each one
// is asserted here rather than left to review:
//
//   1. the approval label sent is `"bulk"`, which is what makes the host refuse
//      a removal-class edit whatever this side sends;
//   2. a removal-class edit is not even offered to the apply;
//   3. the mode is dropped by the lock teardown, so it cannot carry into the
//      next vault.
//
// The first is the load-bearing one: the frontend split is presentation, and
// the host re-derives the same question from the note as it will actually be.
// Sending `"individual"` would hand it forty edits under a label that permits
// removals, which is the shape `decisions/ai/0515` contrasts with a
// frontend filter.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentStart = vi.fn();
const agentApply = vi.fn();
vi.mock("../../src/lib/agent-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/agent-run")>()),
  agentStart: (...a: unknown[]) => agentStart(...a),
  agentApply: (...a: unknown[]) => agentApply(...a),
}));

import { startAgentRun } from "../../src/notes/ai/agentToChat";
import {
  clearAgentForLock,
  getAgent,
  setAutoApply,
} from "../../src/notes/agent/agentStore";
import { __resetChatForTest } from "../../src/notes/ai/chatStore";
import type { ProposedEdit } from "../../src/lib/agent-run";
import { applyOutcome } from "./_agentApplyOutcome";

const COPY = {
  scopeLabel: "This note",
  startFailed: "start failed",
  modelCannotEdit: "model cannot edit",
  stillWorking: "still working",
  autoApplyFailed: "auto apply failed",
  providerRejected: "provider rejected",
  scopeExcluded: "scope excluded",
  // The two sentences a leg that RAN can owe (myne-md/myne#848).
  legFailed: "the run stopped",
  rootGrant: "the scope could not be widened",
  byCause: (cause: string) => `cause:${cause}`,
};

const ORDINARY: ProposedEdit = {
  noteId: "n1",
  anchor: "one two",
  replacement: "one three",
};

/** A `trashed:` edit — one member of the removal class. The roster is every
 *  field `isLiveNote` reads, and it is the host that enforces it; this is the
 *  frontend mirror refusing to offer one. */
const REMOVING: ProposedEdit = {
  noteId: "n2",
  anchor: "title: x",
  replacement: "title: x\ntrashed: 2026-08-21T00:00:00Z",
};

function stepResult(edits: ProposedEdit[]) {
  return {
    view: {
      runId: "r1",
      scopeTotal: 2,
      userGrants: 1,
      modelGrants: 0,
      cancelled: false,
    },
    proposal: { edits, newNotes: [], summary: "" },
    end: { kind: "finished" as const },
    iterations: 3,
    notesRead: 1,
    charsOffDevice: null,
    excludedCount: 0,
  };
}

beforeEach(() => {
  clearAgentForLock();
  __resetChatForTest();
  agentStart.mockReset();
  agentApply.mockReset().mockResolvedValue(applyOutcome());
});

afterEach(() => clearAgentForLock());

describe("the seed is captured before the turn is appended", () => {
  // The one ordering the whole seed depends on, and nothing pinned it: swap the
  // two lines in `startAgentRun` and every other test in this tree stays green,
  // because the sibling suites assert `expect.any(Array)` for this argument,
  // which passes whether the array is empty, correct, or carries the task
  // twice. On a remote provider carrying the task twice is duplicate egress,
  // and seeding the empty assistant turn beside it puts a blank model message
  // in the prompt.
  it("sends the earlier conversation and not the task being sent", async () => {
    agentStart.mockResolvedValue(stepResult([]));
    await startAgentRun("first question", { kind: "notes", value: ["n1"] }, COPY, "en");
    agentStart.mockReset();
    agentStart.mockResolvedValue(stepResult([]));

    await startAgentRun("second question", { kind: "notes", value: ["n1"] }, COPY, "en");

    const history = agentStart.mock.calls[0]?.[3] as { text: string }[];
    const text = history.map((t) => t.text).join("\n");
    expect(text).toContain("first question");
    expect(text).not.toContain("second question");
    // And no empty turn rides along: `sendAgentTurn` pushes an empty agent turn
    // beside the task, so seeding after it would seed that too.
    expect(history.every((t) => t.text.trim().length > 0)).toBe(true);
  });
});

describe("automatic apply", () => {
  it("does nothing when the mode is off", async () => {
    agentStart.mockResolvedValue(stepResult([ORDINARY]));
    await startAgentRun("tidy this", { kind: "notes", value: ["n1"] }, COPY, "en");
    expect(agentApply).not.toHaveBeenCalled();
    // The proposal is still there, which is what makes the review screen open.
    expect(getAgent().proposal.edits).toHaveLength(1);
  });

  it("applies under the bulk label, which is what bounds it host-side", async () => {
    setAutoApply(true);
    agentStart.mockResolvedValue(stepResult([ORDINARY]));
    const written = vi.fn();
    await startAgentRun("tidy this", { kind: "notes", value: ["n1"] }, COPY, "en", written);

    expect(agentApply).toHaveBeenCalledTimes(1);
    const [runId, edits, newNotes, settings, approval] = agentApply.mock.calls[0] as [
      string,
      ProposedEdit[],
      number[],
      unknown[],
      string,
    ];
    expect(runId).toBe("r1");
    expect(edits).toEqual([ORDINARY]);
    expect(newNotes).toEqual([]);
    // **The settings list is empty, and that is the rule rather than an
    // omission** (myne-md/myne#850). Automatic apply exists to skip the review
    // screen for note edits inside a grant the user already made; a setting sits
    // inside no grant, so it always goes to the review screen. The host enforces
    // the same thing in `apply_settings_approved`'s bulk carve-out.
    expect(settings).toEqual([]);
    expect(approval).toBe("bulk");
    // The pane is told, or it keeps showing the pre-apply text and writes it
    // back on its next autosave.
    expect(written).toHaveBeenCalledWith(["n1"]);
  });

  it("does not offer a removal-class edit to the automatic apply", async () => {
    setAutoApply(true);
    agentStart.mockResolvedValue(stepResult([ORDINARY, REMOVING]));
    await startAgentRun("tidy these", { kind: "folder", value: "Notes" }, COPY, "en");

    const [, edits] = agentApply.mock.calls[0] as [string, ProposedEdit[]];
    expect(edits).toEqual([ORDINARY]);
    expect(edits).not.toContainEqual(REMOVING);
  });

  it("keeps the review screen shut while it applies, and opens it on failure", async () => {
    setAutoApply(true);
    agentStart.mockResolvedValue(stepResult([ORDINARY]));
    agentApply.mockRejectedValue(new Error("no"));
    await startAgentRun("tidy this", { kind: "notes", value: ["n1"] }, COPY, "en");

    // The flag is cleared whatever happened, so a failed automatic apply
    // degrades to the manual path rather than hiding the proposal forever.
    expect(getAgent().autoApplying).toBe(false);
    expect(getAgent().proposal.edits).toHaveLength(1);
    expect(getAgent().error).toBe(COPY.autoApplyFailed);
  });

  it("is dropped by the lock teardown", async () => {
    setAutoApply(true);
    expect(getAgent().autoApply).toBe(true);
    clearAgentForLock();
    // The act that granted the mode was choosing it while THIS vault was open.
    expect(getAgent().autoApply).toBe(false);
  });
});
