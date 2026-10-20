// @vitest-environment jsdom
//
// The two WIRING halves of the review card that the deletion test found
// unasserted (myne-md/myne#894, from the review).
//
// Both fixes in this branch shipped their pure decision and left the wiring
// pinned by nothing, which is the failure `reviewCardLayout.ts`'s own header
// names: `myne-md/myne#556` unit-tested the threshold while the observer was
// never attached, so the restack never fired at any width and every test was
// green. The question that finds it is the deletion test: empty the effect body
// and name what goes red. Nothing did, for either of these.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

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
import { REVIEW_CARD_SPLIT_MIN_WIDTH } from "../../src/notes/agent/reviewCardLayout";

const REPLACE: ProposedEdit = { noteId: "n1", anchor: "before", replacement: "after" };

/** A `ResizeObserver` whose callbacks the test fires itself. jsdom has none, so
 *  the hook's feature detection takes the window fallback and the wiring under
 *  test never runs: the stub is what makes it reachable. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];
  constructor(private readonly cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  disconnect(): void {
    this.observed.length = 0;
  }
  /** Fire every live observer's callback, the way a real resize would. */
  static fire(): void {
    for (const ro of FakeResizeObserver.instances) {
      if (ro.observed.length > 0) ro.cb();
    }
  }
}

function settleWith(edits: ProposedEdit[] = [REPLACE]) {
  beginRun(null);
  settleStep(
    {
      view: { runId: "run-1", scopeTotal: 3, userGrants: 1, modelGrants: 0, cancelled: false },
      proposal: { edits, newNotes: [], summary: "" },
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

function mount() {
  return render(
    <AgentReview
      onClose={() => {}}
      onNotesWritten={() => {}}
      titleOf={() => "Note"}
      folderOf={() => null}
    />,
  );
}

const originalObserver = globalThis.ResizeObserver;

beforeEach(() => {
  FakeResizeObserver.instances = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
  cleanup();
  clearAgentForLock();
  if (originalObserver === undefined) {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  } else {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalObserver;
  }
});

describe("the card's width decides the diff mode, and the observer is what decides it", () => {
  it("flips to unified below the threshold and back above it", () => {
    settleWith();
    mount();
    fireEvent.click(screen.getByTestId("agentReview.toggleDiff"));
    const view = () => screen.getByTestId("diff.view").getAttribute("data-mode");

    // jsdom measures 0, so the pre-measure answer is the shipped one: split. That
    // is the state the card is in until the observer says otherwise, which is
    // exactly why the observer is the thing worth asserting.
    expect(view()).toBe("split");

    const card = screen.getByTestId("agentReview.screen");
    // 380px is the right panel's AI chat, the case the whole hook exists for.
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      width: 380,
    } as DOMRect);
    act(() => {
      FakeResizeObserver.fire();
    });
    expect(view()).toBe("unified");

    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      width: REVIEW_CARD_SPLIT_MIN_WIDTH,
    } as DOMRect);
    act(() => {
      FakeResizeObserver.fire();
    });
    expect(view()).toBe("split");
  });

  it("observes the card rather than assuming a width", () => {
    // The wiring half, asserted directly: an observer that was never attached and
    // a card whose width never changed look identical from the outside.
    settleWith();
    mount();
    expect(FakeResizeObserver.instances.length).toBeGreaterThan(0);
    expect(
      FakeResizeObserver.instances.some((ro) =>
        ro.observed.includes(screen.getByTestId("agentReview.screen")),
      ),
    ).toBe(true);
  });
});
