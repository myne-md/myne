// @vitest-environment jsdom
//
// Refusals are lifted out of the diff and stated above the run's own summary,
// with a count (myne-md/myne#848).
//
// **This is the test the review said did not exist, and the reason recorded for
// its absence was wrong**: the store does expose the setter (`settleApply`), and
// another suite already drives it. Both acceptance criteria here are claims about
// POSITION and COUNT, and neither was checked anywhere, so deleting the block
// failed nothing.
//
// Asserted on DOM order rather than on the JSX source, because the source order
// is what the criterion is about and a refactor that moved the block below the
// summary would keep the source reading correctly.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
  }),
}));

import type { ProposedEdit } from "../../src/lib/agent-run";
import { AgentReview } from "../../src/screens/AgentReview";
import {
  beginRun,
  clearAgentForLock,
  currentRunEpoch,
  settleApply,
  settleStep,
} from "../../src/notes/agent/agentStore";

const MOVE: ProposedEdit = {
  noteId: "n1",
  kind: "move",
  anchor: "",
  replacement: "Private",
};

function settleWith(edits: ProposedEdit[]) {
  beginRun(null);
  settleStep(
    {
      view: { runId: "run-1", scopeTotal: 1, userGrants: 1, modelGrants: 0, cancelled: false },
      proposal: { edits, newNotes: [], summary: "moved it" },
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

function applyWithRefusals() {
  settleApply(
    {
      applied: 0,
      refused: [{ noteId: "n1", index: 0, reason: "moveIntoExcludedFolder" }],
      refusedNewNotes: [],
      notesWritten: [],
      notesCreated: [],
      restorePoints: [],
    },
    [],
    currentRunEpoch(),
  );
}

afterEach(() => {
  cleanup();
  clearAgentForLock();
});

/** A run whose summary is long enough to clamp. */
function settleWithLongSummary() {
  beginRun(null);
  settleStep(
    {
      view: {
        runId: "run-1",
        scopeTotal: 1,
        userGrants: 1,
        modelGrants: 0,
        cancelled: false,
      },
      proposal: {
        edits: [MOVE],
        newNotes: [],
        summary: "moved it ".repeat(40),
      },
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

describe("the summary is clamped, and can be opened", () => {
  it("clamps a long one behind a disclosure", () => {
    // myne-md/myne#848, on the user's read: "too much of a top text… this should
    // be only something about the diff". A run that moved twenty-three notes
    // answers with the whole itinerary, and a wall of prose above the diff makes
    // the diff the small print.
    settleWithLongSummary();
    render(
      <AgentReview
        onClose={() => {}}
        onNotesWritten={() => {}}
        titleOf={() => "Note"}
        folderOf={() => null}
      />,
    );
    const summary = screen.getByTestId("agentReview.summary");
    expect(summary.getAttribute("data-clamped")).toBe("true");
    expect(summary.style.webkitLineClamp).toBe("3");
    // The model's claim is still ON SCREEN, which is the half a hide would lose:
    // the paragraph above argues a refusal has to be able to contradict it.
    expect(summary.textContent).toContain("moved it");
  });

  it("reveals the whole thing on the disclosure", () => {
    settleWithLongSummary();
    render(
      <AgentReview
        onClose={() => {}}
        onNotesWritten={() => {}}
        titleOf={() => "Note"}
        folderOf={() => null}
      />,
    );
    fireEvent.click(screen.getByTestId("agentReview.summary-toggle"));
    const summary = screen.getByTestId("agentReview.summary");
    expect(summary.getAttribute("data-clamped")).toBeNull();
    expect(summary.style.webkitLineClamp).toBe("");
  });

  it("offers no disclosure over a summary that fits", () => {
    // A control that reveals what is already visible is a control that does
    // nothing, and the short summary is the common case for a question.
    settleWith([MOVE]);
    render(
      <AgentReview
        onClose={() => {}}
        onNotesWritten={() => {}}
        titleOf={() => "Note"}
        folderOf={() => null}
      />,
    );
    expect(screen.getByTestId("agentReview.summary").getAttribute("data-clamped")).toBeNull();
    expect(screen.queryByTestId("agentReview.summary-toggle")).toBeNull();
  });
});

describe("the refusal block", () => {
  it("states the count and the reason", () => {
    settleWith([MOVE]);
    applyWithRefusals();
    render(<AgentReview onClose={() => {}} onNotesWritten={() => {}} titleOf={() => null} folderOf={() => null} />);
    expect(screen.getByTestId("agentReview.refusedCount").textContent).toContain(
      "agent.review.refusedCount:1",
    );
    expect(screen.getByTestId("agentReview.refusedList").textContent).toContain(
      "agent.review.refused.moveIntoExcludedFolder",
    );
  });

  it("sits ABOVE the run's own summary, so the summary cannot describe work that was not done", () => {
    settleWith([MOVE]);
    applyWithRefusals();
    render(<AgentReview onClose={() => {}} onNotesWritten={() => {}} titleOf={() => null} folderOf={() => null} />);
    const block = screen.getByTestId("agentReview.refusedBlock");
    const summary = screen.getByTestId("agentReview.summary");
    const blockIsAbove =
      (block.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(blockIsAbove, "the refusal block fell below the summary").toBe(true);
  });

  it("keeps the summary on screen when every change was refused", () => {
    // The point is to CONTRADICT the summary, not to hide it: a run whose moves
    // were all refused still shows what the model said it did.
    settleWith([MOVE]);
    applyWithRefusals();
    render(<AgentReview onClose={() => {}} onNotesWritten={() => {}} titleOf={() => null} folderOf={() => null} />);
    expect(screen.getByTestId("agentReview.summary")).toBeTruthy();
  });

  it("renders no block when nothing was refused", () => {
    settleWith([MOVE]);
    settleApply(
      {
        applied: 1,
        refused: [],
        refusedNewNotes: [],
        notesWritten: ["n1"],
        notesCreated: [],
        restorePoints: [["n1", "s1"]],
      },
      [0],
      currentRunEpoch(),
    );
    render(<AgentReview onClose={() => {}} onNotesWritten={() => {}} titleOf={() => null} folderOf={() => null} />);
    expect(screen.queryByTestId("agentReview.refusedBlock")).toBeNull();
  });
});
