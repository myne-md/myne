// @vitest-environment jsdom
//
// The agent review renders its proposal as a SPLIT diff (myne-md/myne#664,
// `src/screens/AgentReview.tsx`).
//
// The screen shipped on `mode="unified"`, which answers "what changed" and
// leaves "what is this replacing?" to the reader, who has to interleave two
// versions in their head line by line. `<DiffView>` already had the two-column
// mode and its own header records why: on a surface where "which side is this?"
// is the whole question, a gutter marker is the worse answer.
//
// Keyed on the RENDERED mode and on both column headings, not on the prop,
// because the failure this guards against is the screen silently going back to
// one column: nothing else in the tree compares the two, `tsc` accepts either
// literal, and a unified diff of the same edit looks entirely plausible.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

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
  settleStep,
} from "../../src/notes/agent/agentStore";

/** A one-word replacement: the case where the word pass has something to say. */
const REPLACE: ProposedEdit = {
  noteId: "n1",
  anchor: "the quick brown fox",
  replacement: "the slow brown fox",
};

function settleWith(edits: ProposedEdit[]) {
  beginRun();
  settleStep(
    {
      view: {
        runId: "run-1",
        scopeTotal: 1,
        userGrants: 1,
        modelGrants: 0,
        cancelled: false,
      },
      proposal: { edits, newNotes: [], summary: "s" },
      end: { kind: "finished" },
      iterations: 1,
      notesRead: 1,
      charsOffDevice: null,
      excludedCount: 0,
      // Inherited from develop, where `settleStep`'s parameter type gained this
      // field and this fixture was not updated. It reddens
      // `check-test-typecheck.mjs`, a blocking ratchet, for every branch cut
      // from develop, so it is fixed here rather than left for the next person
      // (myne-md/myne#727).
      memoryUpdated: 0,
    },
    currentRunEpoch(),
  );
}

function mount() {
  render(<AgentReview onClose={() => {}} onNotesWritten={() => {}} titleOf={() => null} />);
}

afterEach(() => {
  cleanup();
  clearAgentForLock();
});

describe("agent review diff presentation", () => {
  it("renders the proposal in split mode, not unified", () => {
    settleWith([REPLACE]);
    mount();
    const views = screen.getAllByTestId("diff.view");
    expect(views).toHaveLength(1);
    expect(views[0].getAttribute("data-mode")).toBe("split");
  });

  it("labels both columns, so neither side is guessed from position alone", () => {
    settleWith([REPLACE]);
    mount();
    const labels = screen.getAllByTestId("diff.column-label");
    expect(labels.map((el) => el.getAttribute("data-side"))).toEqual(["left", "right"]);
    expect(labels[0].textContent).toBe("agent.review.diffCurrent");
    expect(labels[1].textContent).toBe("agent.review.diffProposed");
  });

  it("faces the old text and the new one across one row", () => {
    settleWith([REPLACE]);
    mount();
    const cells = screen.getAllByTestId("diff.line");
    const left = cells.filter((el) => el.getAttribute("data-side") === "left");
    const right = cells.filter((el) => el.getAttribute("data-side") === "right");
    expect(left).toHaveLength(1);
    expect(right).toHaveLength(1);
    expect(left[0].textContent).toBe("the quick brown fox");
    expect(right[0].textContent).toBe("the slow brown fox");
    // Same row index: the pairing is what makes the two columns comparable.
    expect(left[0].getAttribute("data-index")).toBe(right[0].getAttribute("data-index"));
  });

  it("keeps word-level segments in two columns", () => {
    settleWith([REPLACE]);
    mount();
    const cells = screen.getAllByTestId("diff.line");
    const left = cells.find((el) => el.getAttribute("data-side") === "left")!;
    const right = cells.find((el) => el.getAttribute("data-side") === "right")!;
    const segments = (cell: HTMLElement) =>
      within(cell)
        .getAllByTestId("diff.segment")
        .map((el) => ({ type: el.getAttribute("data-type"), text: el.textContent ?? "" }));
    const leftSegments = segments(left);
    const rightSegments = segments(right);

    // The one-word edit must not read as a whole replaced line: `brown fox`
    // stays unmarked on BOTH sides...
    expect(leftSegments.some((s) => s.type === "same" && s.text.includes("brown fox"))).toBe(true);
    expect(rightSegments.some((s) => s.type === "same" && s.text.includes("brown fox"))).toBe(true);
    // ...and the only marked run is the moved word, on the side it belongs to.
    expect(leftSegments.filter((s) => s.type !== "same")).toEqual([{ type: "del", text: "quick" }]);
    expect(rightSegments.filter((s) => s.type !== "same")).toEqual([{ type: "add", text: "slow" }]);
  });
});
