// @vitest-environment jsdom
//
// The review as a CARD inside the conversation (myne-md/myne#894).
//
// The surface moved out of `Editor.tsx`'s takeover and into the assistant turn
// that proposed the run, so the properties that file's test guarded are not the
// only ones any more: a card has a place in the reading order, a state that says
// it is waiting on the reader, and a width a split diff has to fit in.
//
// What is NOT here, and why: the WHEN (is this run reviewable at all) is
// `reviewableRun`, tested in `tests/notes/agentReviewable.test.ts`; WHICH turn
// shows it is `reviewCardBelongsToTurn`, tested in
// `tests/notes/reviewOwnership.test.ts`; and the refusal block's position
// relative to the model's summary stays in
// `tests/components/AgentReviewRefusalBlock.test.tsx`, unchanged, because the
// order it asserts did not move with the mount point.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// Only `agentApply` is replaced: the rest of the module (the rejection constants,
// the helpers the card imports) stays real, so this test drives the real call
// site rather than a stub of it.
const { applyRejects } = vi.hoisted(() => ({ applyRejects: vi.fn() }));
vi.mock("../../src/lib/agent-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/agent-run")>()),
  agentApply: (...args: unknown[]) => applyRejects(...args),
}));

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
  clearAgent,
  clearAgentForLock,
  currentRunEpoch,
  failRun,
  settleStep,
} from "../../src/notes/agent/agentStore";
import { isReviewCardNarrow } from "../../src/notes/agent/reviewCardLayout";
import {
  approvedNewNoteIndices,
  keptSettings,
} from "../../src/notes/agent/agentStore";

const MOVE: ProposedEdit = {
  noteId: "n1",
  kind: "move",
  anchor: "",
  replacement: "01 - PROJECTS/",
};

function settleWith(edits: ProposedEdit[] = [MOVE]) {
  beginRun(null);
  settleStep(
    {
      view: { runId: "run-1", scopeTotal: 12, userGrants: 1, modelGrants: 0, cancelled: false },
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

function mount(onClose: () => void = () => {}) {
  return render(
    <AgentReview onClose={onClose} onNotesWritten={() => {}} titleOf={() => "Note"} folderOf={() => null} />,
  );
}

afterEach(() => {
  cleanup();
  clearAgentForLock();
});

describe("the card says it is waiting on you", () => {
  it("states the wait while nothing has been applied", () => {
    // The card is a REQUEST, and this is the row that says so. What is asserted
    // here is the state itself, because a mark that moves next to no sentence is
    // decoration: the row carries a tone and a sentence, and no motion.
    settleWith();
    mount();
    const status = screen.getByTestId("agentReview.status");
    expect(status.getAttribute("data-state")).toBe("waiting");
    expect(status.textContent).toContain("agent.review.statusWaiting");
    // No dot beside it: the headline is the whole state now, and a second mark on
    // the same line said it twice (myne-md/myne#894, on the user's read).
    expect(
      screen.getByTestId("agentReview.screen").querySelector(".myne-review-status__dot"),
    ).toBeNull();
    // **And no looping motion on it**, which is the correction `motion-canon`
    // forced: PRODUCT.md principle 4 admits no pulsing state indicator, and a
    // card waiting on the READER reports no work in flight. Asserted because the
    // tempting version is one line of CSS away, and the guard that caught it
    // reads the stylesheet rather than this file.
    expect(status.getAttribute("data-motion")).toBeNull();
  });

  it("paints the tile in the same state the headline reads", () => {
    // One derived value, two visible consequences, so the colour and the
    // sentence cannot come from two conditions that drift. The tile is
    // decorative and carries no testid; the state is what a test can hold.
    settleWith();
    mount();
    expect(screen.getByTestId("agentReview.status").getAttribute("data-state")).toBe(
      "waiting",
    );
    expect(
      screen.getByTestId("agentReview.screen").querySelector(".myne-review-tile")
        ?.getAttribute("data-state"),
    ).toBe("waiting");
  });

  it("names the card for a screen reader, since the header no longer prints a title", () => {
    // The header's headline is the STATE, not the card's name, so the name moved
    // to the group's label, and `agent.review.title` is the string it uses,
    // which is what keeps that key alive.
    settleWith();
    mount();
    const card = screen.getByTestId("agentReview.screen");
    expect(card.getAttribute("role")).toBe("group");
    expect(card.getAttribute("aria-label")).toBe("agent.review.title");
  });

  it("reports the decision up, and reports it BEFORE the close that drops the run", () => {
    // The surface above owns the transcript, so it owns the write, and the order
    // matters: `onClose` drops the run, so an outcome reported after it would be
    // reported about a run the card can no longer name.
    const decisions: string[] = [];
    const onClose = () => decisions.push("close");
    settleWith();
    render(
      <AgentReview
        onClose={onClose}
        onNotesWritten={() => {}}
        onDecision={(outcome) => decisions.push(outcome)}
        titleOf={() => "Note"}
        folderOf={() => null}
      />,
    );
    fireEvent.click(screen.getByTestId("agentReview.rejectAll"));
    expect(decisions).toEqual(["rejected", "close"]);
  });

  it("keeps the scope total on screen, which is the only bound on accumulation", () => {
    settleWith();
    mount();
    expect(screen.getByTestId("agentReview.scopeTotal").textContent).toContain(
      "agent.review.scopeTotal:12",
    );
  });

  it("gives a settings-only proposal an exit and refuses everything in it", () => {
    // **The dead end the review forced a fix for, and which nothing asserted.**
    // `rows` counts edits, so a settings-only proposal (which this surface renders
    // on purpose, myne-md/myne#850) painted "Reject all" disabled, "...0 changes"
    // disabled, and nothing else: a decision card whose every control was dead,
    // now that the always-enabled close control is gone. Injecting the pre-fix
    // gate left every suite green, which is why this case exists.
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
          edits: [],
          newNotes: [],
          settings: [{ intentId: "editor.weekly-notes-folder", value: "J/Weekly" }],
          summary: "",
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
    mount();

    const reject = screen.getByTestId("agentReview.rejectAll");
    expect(
      reject.hasAttribute("disabled"),
      "a settings-only proposal must be refusable",
    ).toBe(false);
    // And the control says how much one click drops, which is the only notice the
    // reader gets: this is the single act that discards the whole proposal.
    expect(
      screen.getByTestId("agentReview.rejectAllCount").textContent,
    ).toBe("1");

    act(() => {
      fireEvent.click(reject);
    });
    expect(keptSettings()).toHaveLength(0);
    expect(approvedNewNoteIndices()).toHaveLength(0);
  });

  it("names the cause of a refused apply, which is the line this change exists for", () => {
    // **The one call site the apply-failure work is about, and it was unasserted**
    // (myne-md/myne#894, from the review: injecting the old generic sentence back
    // left every suite green, because the other tests drive `failRun` directly and
    // so pin the renderer, never the `catch`). The wire tag is the Rust variant
    // name, not the snake_case `kind()` the host logs, which is the spelling bug
    // that made every cause read as the generic sentence in the first place.
    applyRejects.mockRejectedValue({ kind: "WriteFailed" });
    settleWith();
    mount();
    act(() => {
      fireEvent.click(screen.getByTestId("agentReview.approveAll"));
    });
    return vi.waitFor(() => {
      expect(screen.getByTestId("agentReview.error").textContent).toBe(
        "agent.review.applyFailedCause.write",
      );
    });
  });

  it("drops the request once the apply FAILED, and states the cause", () => {
    // A status that kept inviting the act after the act failed is the shape this
    // repository writes tests for. The cause comes from the error object now
    // (`applyFailureMessage`), so the card cannot say "waiting" over a failure.
    settleWith();
    mount();
    act(() => {
      failRun("agent.review.applyFailedCause.write");
    });
    const status = screen.getByTestId("agentReview.status");
    expect(status.getAttribute("data-state")).toBe("failed");
    expect(screen.getByTestId("agentReview.error").textContent).toBe(
      "agent.review.applyFailedCause.write",
    );
  });
});

describe("dismissal stays deliberate", () => {
  it("does not close on Escape", () => {
    // myne-md/myne#549's property, kept across the move (myne-md/myne#894).
    // Closing discards a proposal the user has not applied, so neither Escape nor
    // a misplaced click may do it; the card has no such handler at all, and this
    // is what says so.
    const onClose = vi.fn();
    settleWith();
    mount(onClose);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId("agentReview.screen")).not.toBeNull();
  });

  it("does not close on a click on the card itself", () => {
    const onClose = vi.fn();
    settleWith();
    mount(onClose);
    fireEvent.click(screen.getByTestId("agentReview.screen"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves through Reject all, which rejects the rows AND drops the run", () => {
    // **The × is gone and this is the exit** (myne-md/myne#894, on the user's
    // read: "drop the ×, reject all will do that job"). What the card offers is
    // approve or reject; a third control that only dismissed the proposal was the
    // one that needed the rule "closing discards a proposal you have not applied"
    // written beside it.
    settleWith();
    mount(clearAgent);
    const onClose = vi.fn();
    cleanup();
    settleWith();
    mount(onClose);
    fireEvent.click(screen.getByTestId("agentReview.rejectAll"));
    expect(onClose).toHaveBeenCalled();
    // And no × is left to find, so a caller cannot re-add a dismissal path that
    // skips the rejection.
    expect(screen.queryByTestId("agentReview.close")).toBeNull();
  });
});

describe("the diff mode follows the card's width", () => {
  it("renders one line per change, and the diff only on request", () => {
    // **The compact shape, asserted as a shape** (myne-md/myne#894, second pass).
    // The first version rendered a bordered box and an inline two-column diff per
    // change, which is the dialog's body with a smaller frame around it. What a
    // row owes before the decision is WHICH note and WHAT KIND of change; the
    // text is behind its own disclosure.
    settleWith([{ noteId: "n1", anchor: "before", replacement: "after" }]);
    mount();
    const row = screen.getByTestId("agentReview.edit");
    expect(row.textContent).toContain("agent.review.rowReplace:");
    expect(row.querySelector("[data-mode]")).toBeNull();
    // jsdom has no layout, so the card measures 0, the pre-measure answer, which
    // is deliberately the shipped one (see `isReviewCardNarrow`). That is what
    // makes this assertion about the DEFAULT rather than about a measurement.
    expect(isReviewCardNarrow(0)).toBe(false);
    fireEvent.click(screen.getByTestId("agentReview.toggleDiff"));
    expect(row.querySelector("[data-mode]")?.getAttribute("data-mode")).toBe("split");
  });

  it("says a move in one line, with the destination on it", () => {
    settleWith([{ noteId: "n1", kind: "move", anchor: "", replacement: "01 - PROJECTS/" }]);
    mount();
    const row = screen.getByTestId("agentReview.edit");
    expect(row.textContent).toContain("agent.review.rowMove");
    expect(row.getAttribute("data-kind")).toBe("move");
    // The folder PAIR is what a reader judges a move by, so it is one press away
    // rather than on every row of every card.
    fireEvent.click(screen.getByTestId("agentReview.toggleDiff"));
    expect(screen.getByTestId("agentReview.moveTo").textContent).toBe("01 - PROJECTS/");
  });

  it("carries no run figures of its own", () => {
    // The turn's footprint owns them (myne-md/myne#848), and the card carried a
    // second copy in its footer.
    settleWith();
    mount();
    expect(screen.queryByTestId("agentReview.runSummary")).toBeNull();
  });

  it("knows when it is too narrow for one", () => {
    // The measurement itself, at the boundary the pure function exists for. The
    // sidebar's chat column is ~380px and the split diff's header says why two
    // columns beat a gutter marker wherever they fit.
    expect(isReviewCardNarrow(380)).toBe(true);
    expect(isReviewCardNarrow(559)).toBe(true);
    expect(isReviewCardNarrow(560)).toBe(false);
    expect(isReviewCardNarrow(1200)).toBe(false);
  });
});
