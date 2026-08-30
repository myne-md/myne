// @vitest-environment jsdom
//
// The mobile last-run undo (myne-md/myne#456 task 13).
//
// **What is under test is the OFFER and the SENTENCE, in that order.**
//
// The offer: `design-notes/ai/0518` says it outlives the review screen. The
// record lives host-side keyed by the run id, so this strip reads it rather
// than remembering it, and the logic doing that reading is shared verbatim with
// desktop. Nothing here re-tests the hook's arithmetic; what is asserted is
// that this surface reads it and acts on it.
//
// The sentence: the record goes with the run, because it is in the same
// in-memory state that a lock, a vault switch or the OS reclaiming the app all
// take. Persisting it would put verbatim note plaintext on disk and reverse the
// argument `design-notes/ai/0515` rests on, and snapshot metadata records no
// origin so the record cannot be rebuilt from the store afterwards either. The
// limit is therefore not a thing to fix but a thing to SAY, and saying it
// without naming the durable path is warning someone about a loss rather than
// pointing them at a remedy.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { clearAgent } from "@myne/agent-store";
import type { AgentUndoResult, AppliedRun } from "@myne/agent-protocol";

// The COMPLETE binding mock, from one place. See `helpers/agentRunMock.ts`.
import {
  agentLastRun,
  agentRunModule,
  agentUndo,
  resetAgentRunMock,
} from "../helpers/agentRunMock";

vi.mock("../../src/lib/agent-run", () => agentRunModule());

const { AiUndoStrip } = await import("../../src/app/flows/AiUndoStrip");

const RUN: AppliedRun = {
  runId: "run-1",
  restorePoints: [
    ["n1", "s1"],
    ["n2", "s2"],
  ],
  notesCreated: 1,
};
const REPORT: AgentUndoResult = {
  reverted: 2,
  failed: [],
  notesCreatedNotReverted: 1,
};

function mount(props: Partial<Parameters<typeof AiUndoStrip>[0]> = {}) {
  const onReverted = vi.fn();
  const onOpenHistory = vi.fn();
  render(<AiUndoStrip onReverted={onReverted} onOpenHistory={onOpenHistory} {...props} />);
  return { onReverted, onOpenHistory };
}

beforeEach(() => {
  resetAgentRunMock();
  // This file's subject IS the offer, so it overrides the helper's null.
  agentLastRun.mockResolvedValue(RUN);
  clearAgent();
});
afterEach(cleanup);

describe("AiUndoStrip", () => {
  it("offers the undo without any review screen being open", async () => {
    // The whole of `design-notes/ai/0518`: the record is host-side and this
    // strip reads it, so the offer does not die with a screen.
    mount();
    await waitFor(() => expect(screen.getByTestId("ai.undo-action")).toBeTruthy());
    expect(screen.getByTestId("ai.undo-summary")).toBeTruthy();
    expect(agentLastRun).toHaveBeenCalled();
  });

  it("reverses the whole run in one action", async () => {
    agentUndo.mockResolvedValue(REPORT);
    const { onReverted } = mount();
    await waitFor(() => expect(screen.getByTestId("ai.undo-action")).toBeTruthy());

    fireEvent.click(screen.getByTestId("ai.undo-action"));

    await waitFor(() => expect(screen.getByTestId("ai.undo-result")).toBeTruthy());
    // The RUN ID, not the snapshot list. One command rather than N restores
    // from here: "the whole run reverts as one action" is the property the
    // restore point exists for, and a loop in the WebView is a property that
    // holds only while nobody interrupts it.
    expect(agentUndo).toHaveBeenCalledWith("run-1");
    expect(agentUndo).toHaveBeenCalledTimes(1);
    // Every note it restored, so the surface behind can reload them.
    expect(onReverted).toHaveBeenCalledWith(["n1", "n2"]);
    // And the offer is gone: the host consumed its record, so a second press
    // would report `noSuchRun`.
    expect(screen.queryByTestId("ai.undo-action")).toBeNull();
  });

  it("says the half an undo cannot do", async () => {
    agentUndo.mockResolvedValue(REPORT);
    mount();
    await waitFor(() => expect(screen.getByTestId("ai.undo-action")).toBeTruthy());
    fireEvent.click(screen.getByTestId("ai.undo-action"));

    await waitFor(() => expect(screen.getByTestId("ai.undo-result")).toBeTruthy());
    // "The run was undone" otherwise reads as covering the notes it created,
    // and a create has no restore point to revert to.
    expect(screen.getByTestId("ai.undo-result").textContent).toContain(
      "createdNotReverted",
    );
  });

  it("states the limit AND names the durable path, on both arms", async () => {
    agentUndo.mockResolvedValue(REPORT);
    const { onOpenHistory } = mount();
    await waitFor(() => expect(screen.getByTestId("ai.undo-session-only")).toBeTruthy());
    // Before the undo.
    expect(screen.getByTestId("ai.undo-history")).toBeTruthy();

    fireEvent.click(screen.getByTestId("ai.undo-action"));
    await waitFor(() => expect(screen.getByTestId("ai.undo-result")).toBeTruthy());
    // And after it. The run's record is spent either way, and the version
    // history is what remains, so the sentence is still the honest one.
    expect(screen.getByTestId("ai.undo-session-only")).toBeTruthy();

    fireEvent.click(screen.getByTestId("ai.undo-history"));
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });

  it("makes no offer it cannot honour", async () => {
    // No route to a history sheet, no button pointing at one. The sentence
    // still states the limit, because that half is true regardless.
    mount({ onOpenHistory: undefined });
    await waitFor(() => expect(screen.getByTestId("ai.undo-session-only")).toBeTruthy());
    expect(screen.queryByTestId("ai.undo-history")).toBeNull();
  });

  it("renders nothing when the host holds no record", async () => {
    // What a lock, a vault switch or the OS reclaiming the app leaves behind.
    // The strip does not model any of those events; it asks, and the answer is
    // null. Also the fail-closed path: a read that THREW must not leave an
    // Undo button that would fail on press.
    agentLastRun.mockResolvedValue(null);
    mount();
    await waitFor(() => expect(agentLastRun).toHaveBeenCalled());
    expect(screen.queryByTestId("ai.undo")).toBeNull();

    cleanup();
    agentLastRun.mockRejectedValue(new Error("locked"));
    mount();
    await waitFor(() => expect(agentLastRun).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("ai.undo-action")).toBeNull();
  });
});
