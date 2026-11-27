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
  settleApply,
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
  // so the card offered four half-sentences instead of two buttons. Forbidding a
  // break inside a label fixed the shredding and left the real complaint: the row
  // still did not fit, so `flexWrap` moved the primary act down a line and the
  // user read the pair as stacked. A footer with exactly two closing acts does
  // not wrap at all: the row is `nowrap`, both buttons may shrink, and the
  // remaining slack goes to a spacer that can collapse to nothing.
  it("keeps the two closing acts on one line, and lets them shrink", () => {
    settleWith([ORDINARY]);
    mount();
    const reject = screen.getByTestId("agentReview.rejectAll");
    const approve = screen.getByTestId("agentReview.approveAll");
    expect(reject.style.whiteSpace).toBe("nowrap");
    expect(approve.style.whiteSpace).toBe("nowrap");
    const footer = approve.closest("footer");
    expect(footer?.style.flexWrap).toBe("nowrap");
    // Both may give way, or a label that fits its line at 340px overflows the
    // card the moment the panel is narrower. `minWidth: 0` is what lets a flex
    // item below its content width at all.
    for (const act of [reject, approve]) {
      expect(act.style.minWidth).toBe("0px");
      expect(act.style.flexGrow).toBe("0");
    }
    // The spacer collapses rather than keeping a line of its own, which is what
    // pushed both acts down in the report. Asserted on `min-width`, because
    // jsdom drops the `flex: "1 1 0"` shorthand.
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

// **A footer whose own labels say it would do nothing** (2026-11-27, reported
// from a real run with "Apply automatically" on: the card ended in "Reject all
// 0" beside a live-looking "Approve 0 changes", under a headline reading
// "2 changes applied"). Both counts are zero because the deciding is done, and
// the pair was still painted. The same emptiness arrives the other way, when a
// reader approves or rejects every row by hand, so the rule is "nothing left to
// decide" rather than "the run was automatic".
describe("nothing left to decide", () => {
  it("offers no decision when the run applied everything itself", () => {
    settleWith([], [{ title: "New note", body: "b", folder: null }]);
    // The automatic path settles its own apply; no click happens in this test.
    // A created note carries no restore point, so there is nothing to undo
    // either, and the footer has nothing to hold.
    settleApply(
      applyOutcome({
        applied: 0,
        notesCreated: ["new-1"],
        notesWritten: [],
        restorePoints: [],
      }),
      [],
      currentRunEpoch(),
      [],
      [0],
    );
    mount();
    expect(screen.queryByTestId("agentReview.rejectAll")).toBeNull();
    expect(screen.queryByTestId("agentReview.approveAll")).toBeNull();
    expect(screen.getByTestId("agentReview.screen").querySelector("footer")).toBeNull();
    // The card itself stays, and says what landed: it is the run's report as
    // well as its request.
    expect(screen.getByTestId("agentReview.appliedCount").textContent).toBe(
      "agent.review.appliedCount:1",
    );
  });

  it("keeps the pair while any row is still decidable", () => {
    // The other direction, so the rule cannot pass by removing the footer from
    // every card: one of two edits landed, one is still waiting.
    settleWith([ORDINARY, { ...ORDINARY, anchor: "three", replacement: "four" }]);
    settleApply(applyOutcome(), [0], currentRunEpoch());
    mount();
    expect(screen.getByTestId("agentReview.rejectAll").textContent).toContain(
      "agent.review.rejectAll",
    );
    expect(screen.getByTestId("agentReview.approveAll").textContent).toBe(
      "agent.review.approveAll:1",
    );
  });
});
