// @vitest-environment jsdom
//
// Refusals, and where they are read (myne-md/myne#848, re-homed by
// myne-md/myne#894's review).
//
// **The property never moved; the surface that can hold it did.** The rule is that
// the host's fact must not be read after the model's claim in the order that
// flatters the model. It was the review card's first body region, which worked
// while the card rendered the summary too. The card is now a decision surface and
// the model's prose lives on the transcript turn, so a block inside the card would
// sit UNDER the prose: exactly the misreading the rule exists to prevent. So the
// block renders in the turn, above the answer (`ConversationSurface`), and the
// ordering assertion lives where both halves are siblings
// (`tests/components/AgentPane.test.tsx`, which drives a real transcript).
//
// What this file still owns, since the block is exported and used by the turn: how
// it renders, and the negative that the card does NOT carry a second copy.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
  }),
}));

import type { AgentApplyResult, ProposedEdit } from "../../src/lib/agent-run";
import { AgentReview, RefusalBlock } from "../../src/screens/AgentReview";
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

/** An apply that refused its one edit. */
const REFUSED: AgentApplyResult = {
  applied: 0,
  refused: [{ noteId: "n1", index: 0, reason: "moveIntoExcludedFolder" }],
  refusedNewNotes: [],
  notesWritten: [],
  notesCreated: [],
  restorePoints: [],
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

function mountCard() {
  render(
    <AgentReview
      onClose={() => {}}
      onNotesWritten={() => {}}
      titleOf={() => "Note"}
      folderOf={() => null}
    />,
  );
}

afterEach(() => {
  cleanup();
  clearAgentForLock();
});

describe("the refusal block", () => {
  it("states the count and the reason", () => {
    render(<RefusalBlock result={REFUSED} />);
    expect(screen.getByTestId("agentReview.refusedCount").textContent).toContain(
      "agent.review.refusedCount:1",
    );
    expect(screen.getByTestId("agentReview.refusedList").textContent).toContain(
      "agent.review.refused.moveIntoExcludedFolder",
    );
  });

  it("counts refused settings in the same sentence", () => {
    // **All three kinds, counted together** (from an earlier review): a refused
    // setting once rendered a block reading "0 changes could not be applied" above
    // a list with an entry in it, and the row for that same change said "Applied".
    render(
      <RefusalBlock
        result={{
          ...REFUSED,
          refusedSettings: [{ intentId: "editor.weekly-notes-folder", index: 0, reason: "writeFailed" }],
        }}
      />,
    );
    expect(screen.getByTestId("agentReview.refusedCount").textContent).toContain(
      "agent.review.refusedCount:2",
    );
  });

  it("is NOT rendered by the card, so the prose above it stays first", () => {
    settleWith([MOVE]);
    mountCard();
    act(() => {
      settleApply(REFUSED, [], currentRunEpoch());
    });
    expect(screen.queryByTestId("agentReview.refusedBlock")).toBeNull();
  });

  it("leaves every refused row actionable", () => {
    // A refused row is not in `appliedEdits`, so it stays in the proposal with its
    // own Reject: the reader can resolve it rather than staring at a refusal they
    // cannot act on.
    settleWith([MOVE]);
    mountCard();
    act(() => {
      settleApply(REFUSED, [], currentRunEpoch());
    });
    expect(screen.getByTestId("agentReview.edit")).toBeTruthy();
    expect(screen.getByTestId("agentReview.toggleEdit")).toBeTruthy();
  });
});

describe("the model's summary is not in the card", () => {
  it("does not render it, however long it is", () => {
    // **The other half of the ordering rule.** The summary is the model's claim;
    // the card is the host's account of what would be and was written. Keeping the
    // claim out of the decision surface is what makes "the refusal cannot be read
    // after the thing it contradicts" true by construction rather than by DOM
    // order inside one component. It is NOT hidden from the user: the turn that
    // owns the card renders it as `ai.agent-answer`, with its note mentions
    // clickable.
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
        proposal: { edits: [MOVE], newNotes: [], summary: "moved it ".repeat(80) },
        end: { kind: "finished" },
        iterations: 1,
        notesRead: 1,
        charsOffDevice: null,
        excludedCount: 0,
        memoryUpdated: 0,
      },
      currentRunEpoch(),
    );
    mountCard();
    const card = screen.getByTestId("agentReview.screen");
    expect(card.textContent).not.toContain("moved it");
  });
});
