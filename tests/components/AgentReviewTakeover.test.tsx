// @vitest-environment jsdom
//
// Component tests for `src/notes/agent/components/AgentReviewTakeover.tsx`
// (myne-md/myne#529): WHEN the review screen is on top of the editor.
//
// **The property under test is the `awaitingScope` case, and it is the one that
// shipped wrong.** The takeover used to be an `Editor.tsx` boolean set by an
// `onRunSettled()` callback the composer fired after every `agentStart`, so a
// run that stopped to ASK for a folder opened a review of a proposal the model
// had not finished making, on top of the expansion dialog that was waiting for
// an answer. `ag5` caught it against the real binary; these run everywhere.
//
// Keyed on what is RENDERED for a given store state rather than on a prop,
// because the whole point of the fix is that no caller decides this any more.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// The screen itself is not under test here and mounting it would pull in the
// whole apply path. What matters is whether it is asked for at all.
vi.mock("../../src/screens/AgentReview", () => ({
  AgentReview: () => <div data-testid="stub-review" />,
}));

import type { LoopEnd } from "../../src/lib/agent-run";
import { AgentReviewTakeover } from "../../src/notes/agent/components/AgentReviewTakeover";
import {
  beginRun,
  clearAgentForLock,
  currentRunEpoch,
  settleStep,
} from "../../src/notes/agent/agentStore";

const VIEW = {
  runId: "run-1",
  scopeTotal: 3,
  userGrants: 1,
  modelGrants: 0,
  cancelled: false,
};

function settle(end: LoopEnd) {
  settleStep({
    view: VIEW,
    proposal: { edits: [], newNotes: [], summary: "" },
    end,
    iterations: 1,
    notesRead: 1,
    charsOffDevice: null,
    excludedCount: 0,
  }, currentRunEpoch());
}

function mount() {
  render(<AgentReviewTakeover titleOf={() => null} onNotesWritten={() => {}} />);
}

afterEach(() => {
  cleanup();
  clearAgentForLock();
});

describe("AgentReviewTakeover", () => {
  it("renders nothing before a run has started", () => {
    mount();
    expect(screen.queryByTestId("editor.agent-review")).toBeNull();
  });

  it("renders nothing while the run is still working", () => {
    beginRun();
    mount();
    expect(screen.queryByTestId("editor.agent-review")).toBeNull();
  });

  it("does NOT take over when the run stopped to ask for scope", () => {
    // The regression. An `awaitingScope` end is a question, not a proposal, and
    // the dialog that asks it lives underneath this overlay.
    beginRun();
    settle({ kind: "awaitingScope", folder: "Projects", reason: "why" });
    mount();
    expect(screen.queryByTestId("editor.agent-review")).toBeNull();
  });

  // The other direction, so the gate cannot pass by refusing everything. Each
  // of these leaves a proposal the user is entitled to see, including a partial
  // one, which is why `cancelled`, `exhaustedIterations` and `stalled` are here
  // too. A stalled run in particular can carry edits: it proposed something and
  // then went round in circles, and hiding those would throw away work the user
  // paid a provider for.
  for (const end of [
    { kind: "finished" } as const,
    { kind: "cancelled" } as const,
    { kind: "exhaustedIterations" } as const,
    { kind: "stalled", barrenIterations: 3 } as const,
  ]) {
    it(`takes over when the run ended ${end.kind}`, () => {
      beginRun();
      settle(end);
      mount();
      expect(screen.queryByTestId("editor.agent-review")).not.toBeNull();
      expect(screen.queryByTestId("stub-review")).not.toBeNull();
    });
  }

  it("stops taking over once the run is dropped", () => {
    // Closing calls `clearAgent()`, which drops the run. That is what makes the
    // rule false again; there is no second flag to unset.
    beginRun();
    settle({ kind: "finished" });
    mount();
    expect(screen.queryByTestId("editor.agent-review")).not.toBeNull();
    cleanup();
    clearAgentForLock();
    mount();
    expect(screen.queryByTestId("editor.agent-review")).toBeNull();
  });
});

// myne-md/myne#549. The review became a dialog rather than a full-window
// takeover, and these two are the properties `design-notes/ai/0518` point 3
// rests on: approving is a deliberate act, so the two dismissals every other
// dialog in the tree offers are deliberately absent here. Closing discards a
// proposal the user has not applied, and neither Escape nor a misplaced click
// is a decision to throw the model's work away.
describe("dismissal stays deliberate", () => {
  it("does not close on Escape", () => {
    beginRun();
    settle({ kind: "finished" });
    mount();
    expect(screen.queryByTestId("editor.agent-review")).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByTestId("editor.agent-review")).not.toBeNull();
    expect(screen.queryByTestId("stub-review")).not.toBeNull();
  });

  it("does not close on a backdrop click", () => {
    beginRun();
    settle({ kind: "finished" });
    mount();
    const backdrop = screen.getByTestId("editor.agent-review");

    fireEvent.click(backdrop);

    expect(screen.queryByTestId("editor.agent-review")).not.toBeNull();
    expect(screen.queryByTestId("stub-review")).not.toBeNull();
  });

  it("is a centred card rather than the whole window", () => {
    // The size claim itself, since it is what the entry supersedes: the
    // backdrop covers the window and the card inside it does not. Asserted on
    // the inset that clears the macOS traffic lights, which is the collision
    // that prompted the change.
    beginRun();
    settle({ kind: "finished" });
    mount();
    const backdrop = screen.getByTestId("editor.agent-review");
    expect(backdrop.style.position).toBe("fixed");
    expect(backdrop.style.padding).not.toBe("");
    expect(backdrop.style.padding).not.toBe("0px");
  });
});
