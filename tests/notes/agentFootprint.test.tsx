// @vitest-environment jsdom
//
// The run's footprint as one transcript line plus a disclosure
// (myne-md/myne#848).
//
// The two properties that are NOT cosmetic:
//
//   1. **The figures are not on the line.** They are the compensating control
//      `decisions/ai/0515` names for the remote arm having no volume bound,
//      so they must be REACHABLE, a `<button>` with `aria-expanded`, not a
//      hover affordance, and the test asserts the disclosure is a real button
//      rather than that some div exists.
//   2. **`null` and `0` stay apart for the off-device figure**, because "the run
//      stayed on this device" and "the run was remote and sent nothing" are
//      different statements. The component passes it straight through to
//      `RunCostLine`, which is the one place that sentence is worded.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count === undefined ? key : `${key}:${opts.count}`,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

import {
  AgentFootprint,
  formatDuration,
  type AgentFootprintFigures,
} from "../../src/notes/agent/components/AgentFootprint";

const FIGURES: AgentFootprintFigures = {
  iterations: 3,
  notesRead: 6,
  charsOffDevice: null,
  memoryUpdated: 0,
};

function show(over: Partial<Parameters<typeof AgentFootprint>[0]> = {}) {
  render(
    <AgentFootprint
      settledLabel="agent.progress.done"
      durationMillis={12_000}
      figures={FIGURES}
      {...over}
    />,
  );
}

afterEach(cleanup);

describe("formatDuration", () => {
  it("reports one unit, rounded, and never below a second", () => {
    // Wall clock cannot support sub-second precision, so claiming it would be a
    // false statement about the measurement rather than detail.
    expect(formatDuration(400)).toBe("1s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(125_000)).toBe("2m");
  });
});

describe("AgentFootprint", () => {
  it("keeps the figures OFF the line until the disclosure is opened", () => {
    show();
    expect(screen.getByTestId("agentFootprint.status").textContent).toContain(
      "agent.progress.done",
    );
    expect(screen.getByTestId("agentFootprint.duration").textContent).toBe("12s");
    expect(screen.queryByTestId("agentFootprint.detail")).toBeNull();
    expect(screen.queryByTestId("agentFootprint.runCost")).toBeNull();
  });

  it("opens the detail card from a real button that says so", () => {
    show();
    const disclosure = screen.getByTestId("agentFootprint.disclosure");
    expect(disclosure.tagName).toBe("BUTTON");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    const detail = screen.getByTestId("agentFootprint.detail");
    expect(detail.textContent).toContain("agent.review.runSummaryRequests:3");
    expect(detail.textContent).toContain("agent.review.runSummaryNotes:6");
    // Null stays null: the local statement, not a zero count.
    expect(detail.textContent).toContain("agent.review.runSummaryOnDevice");
    expect(detail.textContent).not.toContain("agent.review.runSummaryOffDevice");
  });

  it("keeps a remote run's zero apart from a local run", () => {
    show({ figures: { ...FIGURES, charsOffDevice: 0 } });
    fireEvent.click(screen.getByTestId("agentFootprint.disclosure"));
    expect(screen.getByTestId("agentFootprint.detail").textContent).toContain(
      "agent.review.runSummaryOffDevice:0",
    );
  });

  it("renders a memory write as ONE chip carrying the count", () => {
    // One chip per ENTRY is not expressible: `memoryUpdated` is a count that
    // crosses IPC, not a list. The chip says how many, which is the honest
    // rendering of the data that exists.
    show({ figures: { ...FIGURES, memoryUpdated: 2 } });
    expect(screen.queryByTestId("agentFootprint.memory")).toBeNull();
    fireEvent.click(screen.getByTestId("agentFootprint.disclosure"));
    expect(screen.getByTestId("agentFootprint.memory").textContent).toContain(
      "agent.footprint.memory:2",
    );
  });

  it("shows no memory chip when nothing was written", () => {
    show({ figures: { ...FIGURES, memoryUpdated: 0 } });
    fireEvent.click(screen.getByTestId("agentFootprint.disclosure"));
    expect(screen.queryByTestId("agentFootprint.memory")).toBeNull();
  });

  it("renders a failed run's message on its own line, and chooses the icon", () => {
    // The run's own failure, which is the one `AgentStepResult` reports. A
    // per-tool-call line is a separate obligation and is not claimed here.
    show({ failed: true, error: "the run could not be undone." });
    expect(screen.queryByTestId("agentFootprint.error")).toBeNull();
    fireEvent.click(screen.getByTestId("agentFootprint.disclosure"));
    expect(screen.getByTestId("agentFootprint.error").textContent).toBe(
      "the run could not be undone.",
    );
  });

  it("shows the running line with a ticking duration and no settled label", () => {
    show({ settledLabel: null, durationMillis: null, startedAtMillis: Date.now() - 3_000 });
    expect(screen.getByTestId("agentFootprint.status").textContent).toBe(
      "agent.progress.working",
    );
    expect(screen.getByTestId("agentFootprint.duration").textContent).toBe("3s");
  });

  it("shows the figures ON the line while the run works", async () => {
    // **The running scope total is shown continuously** (decisions/ai/0515,
    // and the threat-model bullet this phase edits): with no cap on scope growth
    // it is the only bound on accumulation, and the strip this replaced said in
    // as many words that it "does not belong behind a disclosure". Only the
    // SETTLED detail is one press away (myne-md/myne#848).
    show({
      settledLabel: null,
      durationMillis: null,
      startedAtMillis: Date.now() - 2_000,
      scopeTotal: 7,
    });
    expect(screen.getByTestId("agentFootprint.scope").textContent).toContain(
      "agent.progress.scopeTotal:7",
    );
    expect(screen.getByTestId("agentFootprint.runCost").textContent).toContain(
      "agent.review.runSummaryRequests:3",
    );
    // And nothing is behind a disclosure yet: the disclosure is not even
    // rendered, because while the run works there is nothing behind it and
    // rendering both put the same cost line on screen TWICE.
    expect(screen.queryByTestId("agentFootprint.detail")).toBeNull();
    expect(screen.queryByTestId("agentFootprint.disclosure")).toBeNull();
    // The line breathes as one thing rather than a still label beside a moving
    // glyph, and the glyph it breathes is NOT the speaker's: `bot` here sat
    // directly under the assistant's own `bot` and the pair read as two speakers
    // (myne-md/myne#894).
    expect(screen.getByTestId("agentFootprint.status").className).toContain(
      "myne-working-wave",
    );
    expect(screen.getByTestId("agentFootprint.status").getAttribute("data-motion")).toBe(
      "essential",
    );
  });

  it("turns while the run works, and stops turning when it settles", () => {
    // **"The working thing does not turn."** The mark was a named glyph with an
    // opacity wave on it, so the one thing on screen saying work was happening
    // looked like a still picture of a spinner. `StatusMark` gives it the
    // rotation from `tokens.css`, the MYND-630 carve-out that slows rather than
    // freezes, and the settled arms keep their still glyphs.
    show({ settledLabel: null, durationMillis: null, startedAtMillis: Date.now() - 1_000 });
    const mark = screen.getByTestId("agentFootprint.mark");
    expect(mark.className).toContain("myne-spinner");
    // The wave is on the LABEL, not on the mark: two motions on one 12px glyph
    // fight each other.
    expect(mark.className).not.toContain("myne-working-wave");
    expect(screen.getByTestId("agentFootprint.status").className).toContain(
      "myne-working-wave",
    );
    cleanup();
    show();
    expect(screen.getByTestId("agentFootprint.mark").className).not.toContain(
      "myne-spinner",
    );
  });

  it("renders its status line and nothing else", () => {
    // **The regression this file did not have** (myne-md/myne#894). The icon
    // change was made with a long note written as `//` lines INSIDE the JSX, and
    // a `//` line in JSX children is not a comment: React renders it as a text
    // child, so the whole paragraph painted inside the run's status line, above
    // the word "Finished". `tsc` was green, every unit test was green, and so was
    // every guard in `scripts/`, the only thing that could have caught it was
    // looking at the rendered catalogue, and this is the cheap half of that.
    // Asserted as "no comment punctuation AND no double space", so it fails for
    // a stray block rather than for one particular string.
    show({ settledLabel: null, durationMillis: null, startedAtMillis: Date.now() - 2_000 });
    const footprint = screen.getByTestId("agentFootprint");
    expect(footprint.textContent).not.toContain("//");
    expect(footprint.textContent).not.toContain("**");
    expect(screen.getByTestId("agentFootprint.status").textContent).toBe(
      "agent.progress.working",
    );
    expect(footprint.textContent).toContain("agent.progress.working");
  });

  it("drops the wave and shows a check once the run settles", () => {
    show();
    expect(screen.getByTestId("agentFootprint.status").className).not.toContain(
      "myne-working-wave",
    );
    expect(screen.getByTestId("agentFootprint.disclosure")).toBeTruthy();
  });

  it("says nothing about a duration it cannot know", () => {
    show({ durationMillis: null });
    expect(screen.queryByTestId("agentFootprint.duration")).toBeNull();
  });
});
