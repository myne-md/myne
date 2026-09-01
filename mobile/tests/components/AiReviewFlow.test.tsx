// @vitest-environment jsdom
//
// The mobile agent review (myne-md/myne#456 task 12).
//
// **This is the screen that authorises writes to note bodies**, so every
// assertion here is about a rule rather than a rendering. Three of them are
// inherited from the desktop screen and one is new to the phone:
//
//   1. a bulk approve structurally cannot carry a removal;
//   2. the running scope total is on screen;
//   3. a refused edit is shown with its cause;
//   4. the BACK GESTURE does not discard an unapplied proposal.
//
// The fourth is the phone's version of `design-notes/ai/0521`'s rule about
// the backdrop and Escape. Android's hardware back and iOS's edge-swipe both
// arrive as a history pop, which is why that is what this file drives.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { clearAgent, currentRunEpoch, getAgent, settleStep } from "@myne/agent-store";
import type { AgentRunView, ProposedEdit } from "@myne/agent-protocol";


// The COMPLETE binding mock, from one place. See `helpers/agentRunMock.ts`.
import { agentApply, agentRunModule, resetAgentRunMock } from "../helpers/agentRunMock";

vi.mock("../../src/lib/agent-run", () => agentRunModule());

// Imported AFTER the mock is registered, not with the static imports above.
// `vi.mock` is hoisted to the top of the file, so a static import of the
// component runs the factory while `helpers/agentRunMock` is still
// initialising: `Cannot access '__vi_import_3__' before initialization`.
const { AiReviewFlow } = await import("../../src/app/flows/AiReviewFlow");

const VIEW: AgentRunView = { runId: "run-1", scopeTotal: 7 };

const PLAIN: ProposedEdit = {
  noteId: "n1",
  anchor: "the old wording here",
  replacement: "the new wording here",
};
const SECOND_ON_SAME_NOTE: ProposedEdit = {
  noteId: "n1",
  anchor: "another passage",
  replacement: "a rewritten passage",
};
const OTHER_NOTE: ProposedEdit = {
  noteId: "n2",
  anchor: "a line",
  replacement: "a better line",
};
/** An edit that takes the note out of the note list. At the diff layer this is
 *  indistinguishable from any other edit, which is the whole reason rule 1
 *  exists. */
const REMOVAL: ProposedEdit = {
  noteId: "n3",
  anchor: "title: Notes",
  replacement: "title: Notes\ntrashed: 2026-08-29T00:00:00Z",
};

const TITLES: Record<string, string> = { n1: "First note", n2: "Second", n3: "Doomed" };
const BODIES: Record<string, string> = {
  n1: "the old wording here\nanother passage",
  n2: "a line",
  n3: "title: Notes",
};

function seed(edits: ProposedEdit[]) {
  // Through the real store, not a stub: the store is shared verbatim with
  // desktop and its accumulation rules are exactly what a stub would get wrong.
  settleStep(
    {
      view: VIEW,
      proposal: { edits, newNotes: [], summary: "" },
      end: { kind: "finished" },
      iterations: 2,
      notesRead: 3,
      charsOffDevice: 5000,
      excludedCount: 0,
    },
    // The store's CURRENT epoch. Required rather than defaulted, by design: a
    // default would compare the epoch to itself and pass unconditionally, which
    // is the opt-in-guard shape the root CLAUDE.md records.
    currentRunEpoch(),
  );
}

function mount() {
  const onClose = vi.fn();
  const onNotesWritten = vi.fn();
  render(
    <AiReviewFlow
      titleOf={(id) => TITLES[id] ?? null}
      bodyOf={(id) => BODIES[id] ?? null}
      onNotesWritten={onNotesWritten}
      onClose={onClose}
    />,
  );
  return { onClose, onNotesWritten };
}

beforeEach(() => {
  resetAgentRunMock();
  clearAgent();
});
afterEach(cleanup);

describe("AiReviewFlow", () => {
  it("opens on a summary, one row per note, with counts", () => {
    seed([PLAIN, SECOND_ON_SAME_NOTE, OTHER_NOTE]);
    mount();

    const rows = screen.getAllByTestId("ai.review-note");
    // Two rows for three edits: grouped by note, which is what makes this a
    // summary rather than a list of diffs.
    expect(rows.map((r) => r.getAttribute("data-note-id"))).toEqual(["n1", "n2"]);
    expect(rows[0].textContent).toContain("First note");
    // And no diff is on screen yet. A unified diff of several notes does not
    // read at phone width, and an unreadable diff makes a deliberate act into
    // theatre.
    expect(screen.queryByTestId("ai.review-diff")).toBeNull();
  });

  it("keeps the running scope total in the header", () => {
    // Rule 2. With no cap on scope growth this number is what bounds
    // accumulation, so it may not be a thing the user scrolls to find.
    seed([PLAIN]);
    mount();
    expect(screen.getByTestId("ai.review-scope")).toBeTruthy();
    expect(screen.getByTestId("ai.review-cost")).toBeTruthy();
  });

  it("shows one note's diff behind a tap, wrapped rather than scrolled sideways", () => {
    seed([PLAIN]);
    mount();
    fireEvent.click(screen.getAllByTestId("ai.review-note")[0]);

    expect(screen.getByTestId("ai.review-diff")).toBeTruthy();
    const del = screen.getAllByTestId("ai.review-diff-del")[0];
    // The page must never scroll horizontally, and a long line of prose is the
    // common case here, so the line wraps instead of overflowing.
    expect(del.style.whiteSpace).toBe("pre-wrap");
    expect(del.style.overflowWrap).toBe("anywhere");
  });

  it("never puts a removal in the bulk Apply", () => {
    // **Rule 1, the load-bearing one.** Every way Myne takes a note out of the
    // note list is a frontmatter field, so at the diff layer a removal looks
    // like any other edit, and "the agent only edits bodies" would quietly
    // become "a silent removal inside a forty-edit approve-all".
    agentApply.mockResolvedValue({
      applied: 2,
      refused: [],
      refusedNewNotes: [],
      notesWritten: ["n1", "n2"],
      notesCreated: [],
      restorePoints: [["n1", "s1"]],
    });
    seed([PLAIN, OTHER_NOTE, REMOVAL]);
    mount();

    // The removal is on screen, in its own place, saying WHICH removal, because
    // one sentence cannot be true for all five.
    const removals = screen.getAllByTestId("ai.review-removal");
    expect(removals).toHaveLength(1);
    expect(removals[0].textContent).toContain("Doomed");
    expect(screen.getByTestId("ai.review-removal-flag").textContent).toBeTruthy();
    // And it is not among the note rows the Apply covers.
    expect(
      screen.getAllByTestId("ai.review-note").map((r) => r.getAttribute("data-note-id")),
    ).toEqual(["n1", "n2"]);

    fireEvent.click(screen.getByTestId("ai.review-apply"));
    return waitFor(() => {
      expect(agentApply).toHaveBeenCalledTimes(1);
      const [runId, sent, newNotes, approval] = agentApply.mock.calls[0];
      expect(runId).toBe("run-1");
      // The removal is absent from the payload...
      expect(sent).toEqual([PLAIN, OTHER_NOTE]);
      // ...and the host is TOLD this was a bulk approval, which is what makes
      // the rule real: it re-derives the removal from the note as it will
      // actually be and refuses one under `"bulk"` regardless of what was sent.
      expect(approval).toBe("bulk");
      // No new notes: a create has no restore point behind it, and handing over
      // the whole proposal is the defect `approvedNewNotes` exists to prevent.
      expect(newNotes).toEqual([]);
    });
  });

  it("is one Apply for the whole run", () => {
    seed([PLAIN, SECOND_ON_SAME_NOTE, OTHER_NOTE]);
    mount();
    // Not one per note and not one per edit. The count on the button is the
    // count the action will send, so the button cannot promise what the action
    // will not do.
    expect(screen.getAllByTestId("ai.review-apply")).toHaveLength(1);
  });

  it("absorbs the back gesture instead of letting it leave the screen", async () => {
    // `design-notes/ai/0521` on a phone. Android's hardware back and iOS's
    // edge-swipe both arrive as a `popstate`, and a stray one that threw the
    // model's work away would be a worse surface than no back at all.
    //
    // **Asserted on the HISTORY ENTRY, not on the screen still being mounted**,
    // and that distinction is the whole test. The first draft dispatched a
    // `popstate` and checked that `onClose` had not fired and the proposal was
    // still in the store. It passed with the entire guard DELETED, because
    // nothing in jsdom unmounts a component on a pop: the assertion held for a
    // reason that had nothing to do with the code under test. Injecting the
    // defect is what found that, and the fix is to assert the mechanism.
    //
    // What actually keeps a real back gesture on this screen is that the screen
    // OWNS a history entry, so a pop consumes that one rather than the app's,
    // and a replacement is pushed immediately or the NEXT back would leave.
    const claimed = () =>
      pushes.filter((p) => (p as { myneAgentReview?: boolean } | null)?.myneAgentReview).length;
    const pushes: unknown[] = [];
    const realPush = window.history.pushState.bind(window.history);
    const spy = vi
      .spyOn(window.history, "pushState")
      .mockImplementation((state: unknown, title: string, url?: string | URL | null) => {
        pushes.push(state);
        realPush(state, title, url);
      });
    try {
      seed([PLAIN]);
      const { onClose } = mount();
      // One entry claimed on mount. Without it the first back leaves.
      expect(claimed()).toBe(1);

      await act(async () => {
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      // And a replacement claimed immediately, or the second back leaves.
      expect(claimed()).toBe(2);
      expect(onClose).not.toHaveBeenCalled();
      expect(getAgent().proposal.edits).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("closes an open diff on the back gesture, which is a real navigation step", async () => {
    seed([PLAIN]);
    mount();
    fireEvent.click(screen.getAllByTestId("ai.review-note")[0]);
    expect(screen.getByTestId("ai.review-diff")).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    // Back to the summary, not out of the screen.
    expect(screen.queryByTestId("ai.review-diff")).toBeNull();
    expect(screen.getByTestId("ai.review")).toBeTruthy();
  });

  it("blocks the write and says so when the apply fails outright", async () => {
    // **The branch a failed restore point lands in.**
    // `RestorePointTaker::capture` returns an `Err` when a snapshot could not
    // be taken and its own contract says an `Err` STOPS the apply, so nothing
    // was written. A whole-call failure is strictly worse than a per-edit
    // refusal and used to be the one outcome with no report at all.
    agentApply.mockRejectedValue(new Error("restore point failed"));
    seed([PLAIN]);
    const { onNotesWritten } = mount();

    fireEvent.click(screen.getByTestId("ai.review-apply"));
    await waitFor(() => expect(screen.getByTestId("ai.review-error")).toBeTruthy());
    // Nothing was recorded as applied, and nothing behind the screen was told
    // to reload: the screen must not look exactly as it did before the tap.
    expect(getAgent().applied).toBeNull();
    expect(onNotesWritten).not.toHaveBeenCalled();
  });

  it("shows a refused edit with its cause", async () => {
    // Rule 3. An edit the host could not place must never be mistaken for one
    // that was not needed.
    agentApply.mockResolvedValue({
      applied: 1,
      refused: [{ noteId: "n2", index: 1, reason: "anchorNotFound" }],
      refusedNewNotes: [],
      notesWritten: ["n1"],
      notesCreated: [],
      restorePoints: [["n1", "s1"]],
    });
    seed([PLAIN, OTHER_NOTE]);
    const { onNotesWritten } = mount();

    fireEvent.click(screen.getByTestId("ai.review-apply"));
    await waitFor(() => expect(screen.getByTestId("ai.review-refused")).toBeTruthy());
    expect(screen.getByTestId("ai.review-refused").children).toHaveLength(1);
    // The HOST's list of what changed, not the one that was sent.
    expect(onNotesWritten).toHaveBeenCalledWith(["n1"]);
  });
});
