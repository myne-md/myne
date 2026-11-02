// @vitest-environment jsdom
//
// The Approve-all button's ENABLEMENT (`src/screens/AgentReview.tsx`,
// myne-md/myne#529).
//
// **A button whose payload the bulk action will not send.** `approveAll` sends
// the bulk-approvable half plus the approved new notes, and `apply()` returns
// early on an empty pair. The button asked a different question: whether ANY
// edit was un-rejected. So a proposal whose only kept edit TRASHES a note, which
// the bulk path structurally cannot carry, left a live primary button that sent
// an empty list and did nothing at all: no write, no report, no message, beside
// a label already reading "Approve all (0)".
//
// The button's own doc comment records the same defect happening one layer down
// (an edit-count-only early return in core) and then one layer up (the button
// counting edits only). This is the third turn of it, so the test is keyed on
// the payload rather than on any count that happens to be nearby.
//
// `ag3` covers the same ground against the real binary and runs only where the
// desktop E2E lane does.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The apply is the one IPC this test drives: the store settles it, and what is
// asserted afterwards is what the CARD will offer, which is the call site.
const { agentApply } = vi.hoisted(() => ({ agentApply: vi.fn() }));
vi.mock("../../src/lib/agent-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/agent-run")>()),
  agentApply: (...a: unknown[]) => agentApply(...a),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
  }),
}));

import type { ProposedEdit } from "../../src/lib/agent-run";
import type { ProposedNote } from "../../src/lib/agent-protocol";
import { AgentReview } from "../../src/screens/AgentReview";
import {
  approvedNewNoteIndices,
  beginRun,
  clearAgentForLock,
  currentRunEpoch,
  getAgent,
  settleStep,
} from "../../src/notes/agent/agentStore";
import { applyOutcome } from "../notes/_agentApplyOutcome";

/** An edit that appends a `trashed:` instant, i.e. one the bulk path refuses. */
const TRASHING: ProposedEdit = {
  noteId: "n1",
  anchor: "title: Ledger",
  replacement: "title: Ledger\ntrashed: 2026-08-16T12:00:00Z",
};

/** An ordinary body edit, which the bulk path carries. */
const ORDINARY: ProposedEdit = {
  noteId: "n1",
  anchor: "one two three",
  replacement: "one two three (edited)",
};

function settleWith(edits: ProposedEdit[], newNotes: ProposedNote[] = []) {
  beginRun(null);
  settleStep({
    view: {
      runId: "run-1",
      scopeTotal: 1,
      userGrants: 1,
      modelGrants: 0,
      cancelled: false,
    },
    proposal: { edits, newNotes, summary: "s" },
    end: { kind: "finished" },
    iterations: 1,
    notesRead: 1,
    charsOffDevice: null,
    excludedCount: 0,
  memoryUpdated: 0,}, currentRunEpoch());
}

function mount() {
  render(
    <AgentReview
      onClose={() => {}}
      onNotesWritten={() => {}}
      titleOf={() => null}
      folderOf={() => null}
    />,
  );
}

afterEach(() => {
  cleanup();
  agentApply.mockReset();
  clearAgentForLock();
});

describe("Approve all", () => {
  it("is disabled when the only kept edit is one the bulk path refuses", () => {
    settleWith([TRASHING]);
    mount();
    const button = screen.getByTestId("agentReview.approveAll");
    expect(button.hasAttribute("disabled")).toBe(true);
    // The label already said zero. The state, not the label, is what the click
    // depended on.
    expect(button.textContent).toBe("agent.review.approveAll:0");
  });

  it("is enabled once there is an ordinary edit beside it", () => {
    // The other direction, so the rule cannot pass by disabling everything.
    settleWith([TRASHING, ORDINARY]);
    mount();
    const button = screen.getByTestId("agentReview.approveAll");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.textContent).toBe("agent.review.approveAll:1");
  });

  it("is enabled when the only work is an approved new note", () => {
    // The other arm of the production gate (`approvedNewNoteIndices(agent)
    // .length > 0`, AgentReview.tsx:174). myne-md/myne#802 deleted the three
    // vacuous `agentBulkApproval` tests that covered a helper defined in the
    // test file, so this drives the real gate through the store instead: a
    // create-only proposal still has work for the bulk action to send.
    settleWith([], [{ title: "New note", body: "b", folder: null }]);
    mount();
    const button = screen.getByTestId("agentReview.approveAll");
    expect(button.hasAttribute("disabled")).toBe(false);
    // **And it says one, not zero** (myne-md/myne#913). A live primary button
    // reading "Approve 0 changes" is a decision surface understating its own
    // payload; the count is what the action sends, across both verbs.
    expect(button.textContent).toBe("agent.review.approveAll:1");
  });

  // Issue #970, item 13. In the AI chat panel the footer ran out of width and
  // broke EACH label across two lines ("Reject / all 2", "Approve 2 / changes"),
  // so the card offered four half-sentences instead of two buttons. The rule is
  // that the row gives way BETWEEN the acts and never inside one.
  it("keeps both act labels on one line and lets the row wrap between them", () => {
    settleWith([ORDINARY]);
    mount();
    const reject = screen.getByTestId("agentReview.rejectAll");
    const approve = screen.getByTestId("agentReview.approveAll");
    expect(reject.style.whiteSpace).toBe("nowrap");
    expect(approve.style.whiteSpace).toBe("nowrap");
    const footer = approve.closest("footer");
    expect(footer?.style.flexWrap).toBe("wrap");
    // The spacer collapses when the row wraps rather than keeping a line of its
    // own, which is what pushed both acts down in the report. Asserted on
    // `min-width`, because jsdom drops the `flex: "1 1 0"` shorthand.
    const spacer = Array.from(footer?.children ?? []).find(
      (el) => el.tagName === "SPAN" && el.textContent === "",
    );
    expect(spacer).toBeTruthy();
    expect(spacer?.getAttribute("style")).toContain("min-width: 0");
  });

  it("keeps a create the host REFUSED actionable, through the real click", async () => {
    // **The deletion test on the call site** (myne-md/myne#913, review rounds
    // three and five). `settleApply` was handed the SENT create indices, so a
    // create the host refused was recorded as applied: its row read "Created",
    // its Reject control disappeared, and that note could never be created for
    // the rest of the run. A test of `landedNewNoteIndices` alone stays green
    // when the CALL SITE passes the wrong list, which is exactly what happened.
    //
    // Reverting `AgentReview.tsx` to `newNoteIndices` must redden this.
    settleWith([], [
      { title: "Landed", body: "a", folder: null },
      { title: "Refused", body: "b", folder: null },
    ]);
    agentApply.mockResolvedValue(
      applyOutcome({
        applied: 1,
        refusedNewNotes: [{ index: 1, reason: "unsafeFrontmatter" }],
        notesCreated: ["new-Landed"],
      }),
    );
    mount();

    fireEvent.click(screen.getByTestId("agentReview.approveAll"));

    await waitFor(() => expect(getAgent().appliedNewNotes.has(0)).toBe(true));
    // The refusal is still offered, so the user can approve it again; the landed
    // one is not, so the button's count matches what is left.
    expect(approvedNewNoteIndices()).toEqual([1]);
  });

  it("counts edits and new notes together", () => {
    settleWith([ORDINARY], [
      { title: "A", body: "a", folder: null },
      { title: "B", body: "b", folder: null },
    ]);
    mount();
    expect(screen.getByTestId("agentReview.approveAll").textContent).toBe(
      "agent.review.approveAll:3",
    );
  });
});
