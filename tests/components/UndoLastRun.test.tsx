// @vitest-environment jsdom
//
// Component tests for `src/notes/agent/components/UndoLastRun.tsx`
// (myne-md/myne#529) — the undo offer that lives OUTSIDE the review screen.
//
// **What these exist to pin is a reachability property, not a rendering one.**
// Undo used to live only on the review screen, which owned the
// `[noteId, snapshotId]` record; closing that screen dropped it, so a guarantee
// the user guide had already published stopped being true the moment the user
// did the ordinary thing. Fixing that meant moving the record host-side and
// having this component ASK for it rather than remember it, and the tests below
// are keyed on that: what it invoked, and what it did with the answer.
//
// The E2E leg (ag4) covers the same property against the real binary and cannot
// run on every platform. These run everywhere, in `pnpm test`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const agentLastRun = vi.fn();
const agentUndo = vi.fn();
vi.mock("../../src/lib/agent-run", () => ({
  agentLastRun: (...a: unknown[]) => agentLastRun(...a),
  agentUndo: (...a: unknown[]) => agentUndo(...a),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
  }),
}));

import { UndoLastRun } from "../../src/notes/agent/components/UndoLastRun";
import {
  clearAgentForLock,
  settleApply,
} from "../../src/notes/agent/agentStore";

const RUN = {
  runId: "run-1",
  restorePoints: [
    ["note-a", "snap-a"],
    ["note-b", "snap-b"],
  ] as [string, string][],
  notesCreated: 1,
};

beforeEach(() => {
  clearAgentForLock();
  agentLastRun.mockReset();
  agentUndo.mockReset();
});
afterEach(cleanup);

describe("UndoLastRun", () => {
  it("renders nothing when the host holds no undoable run", async () => {
    agentLastRun.mockResolvedValue(null);
    const { container } = render(<UndoLastRun />);
    await waitFor(() => expect(agentLastRun).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="agentUndoLast.root"]')).toBeNull();
  });

  it("offers the undo the host reports, with the note count", async () => {
    agentLastRun.mockResolvedValue(RUN);
    render(<UndoLastRun />);
    // The count comes from the restore points, i.e. the notes that were
    // REWRITTEN. Created notes are deliberately not in it: they cannot be
    // reverted, and counting them would overstate what the button does.
    const summary = await screen.findByTestId("agentUndoLast.summary");
    expect(summary.textContent).toContain("agent.undo.offer:2");
    expect(await screen.findByTestId("agentUndoLast.undo")).toBeTruthy();
  });

  it("undoes by RUN ID, not by handing back the snapshot list", async () => {
    // The whole reason the record moved host-side. A caller that passes the
    // list is a caller that had to be alive to hold it.
    agentLastRun.mockResolvedValue(RUN);
    agentUndo.mockResolvedValue({
      reverted: 2,
      failed: [],
      notesCreatedNotReverted: 1,
    });
    render(<UndoLastRun />);
    fireEvent.click(await screen.findByTestId("agentUndoLast.undo"));
    await waitFor(() => expect(agentUndo).toHaveBeenCalledWith("run-1"));
  });

  it("reports what the undo did, including what it could not revert", async () => {
    agentLastRun.mockResolvedValue(RUN);
    agentUndo.mockResolvedValue({
      reverted: 2,
      failed: ["note-c"],
      notesCreatedNotReverted: 1,
    });
    render(<UndoLastRun />);
    fireEvent.click(await screen.findByTestId("agentUndoLast.undo"));
    const result = await screen.findByTestId("agentUndoLast.result");
    expect(result.textContent).toContain("agent.undo.reverted:2");
    expect(result.textContent).toContain("agent.undo.failed:1");
    // Said even though the undo "succeeded". "The run was undone" otherwise
    // reads as covering the notes it created, and it never does.
    expect(result.textContent).toContain("agent.undo.createdNotReverted:1");
  });

  it("withdraws the offer after one undo, so a second press cannot fire", async () => {
    agentLastRun.mockResolvedValue(RUN);
    agentUndo.mockResolvedValue({
      reverted: 2,
      failed: [],
      notesCreatedNotReverted: 0,
    });
    render(<UndoLastRun />);
    fireEvent.click(await screen.findByTestId("agentUndoLast.undo"));
    await screen.findByTestId("agentUndoLast.result");
    expect(screen.queryByTestId("agentUndoLast.undo")).toBeNull();
    expect(agentUndo).toHaveBeenCalledTimes(1);
  });

  it("hands back the reverted note ids so the caller can reload them", async () => {
    // Without this the editor keeps rendering the applied text of a note that
    // has just been reverted underneath it.
    agentLastRun.mockResolvedValue(RUN);
    agentUndo.mockResolvedValue({
      reverted: 2,
      failed: [],
      notesCreatedNotReverted: 0,
    });
    const onReverted = vi.fn();
    render(<UndoLastRun onReverted={onReverted} />);
    fireEvent.click(await screen.findByTestId("agentUndoLast.undo"));
    await waitFor(() =>
      expect(onReverted).toHaveBeenCalledWith(["note-a", "note-b"]),
    );
  });

  it("a LATER run supersedes the previous run's report", async () => {
    // The regression this test exists for: the report used to be kept without
    // the run it described, so after one undo this strip showed that report
    // forever and the next run's offer never rendered, because the two arms are
    // mutually exclusive. It fails the moment the run id is dropped again.
    agentLastRun.mockResolvedValue(RUN);
    agentUndo.mockResolvedValue({
      reverted: 2,
      failed: [],
      notesCreatedNotReverted: 0,
    });
    const { rerender } = render(<UndoLastRun />);
    fireEvent.click(await screen.findByTestId("agentUndoLast.undo"));
    await screen.findByTestId("agentUndoLast.result");

    // A second run applies. The host now reports a different run id.
    agentLastRun.mockResolvedValue({ ...RUN, runId: "run-2" });
    settleApply(
      {
        applied: 3,
        refused: [],
        refusedNewNotes: [],
        notesWritten: ["note-a"],
        notesCreated: [],
        restorePoints: [["note-a", "snap-z"]],
      },
      [0],
    );
    rerender(<UndoLastRun />);

    // The offer is back, and the stale report is gone.
    expect(await screen.findByTestId("agentUndoLast.undo")).toBeTruthy();
    expect(screen.queryByTestId("agentUndoLast.result")).toBeNull();
  });

  it("fails closed when the host cannot be asked", async () => {
    // An Undo button that cannot name a run would fail on press. Showing
    // nothing is the honest state.
    agentLastRun.mockRejectedValue(new Error("locked"));
    const { container } = render(<UndoLastRun />);
    await waitFor(() => expect(agentLastRun).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="agentUndoLast.root"]')).toBeNull();
  });

  it("re-reads rather than guessing when the undo itself fails", async () => {
    // The run may be gone (a lock landed) or the call may simply have failed,
    // and those want different offers. Guessing either way is how a stale
    // button survives a lock.
    agentLastRun.mockResolvedValue(RUN);
    agentUndo.mockRejectedValue(new Error("no such run"));
    render(<UndoLastRun />);
    agentLastRun.mockResolvedValue(null);
    fireEvent.click(await screen.findByTestId("agentUndoLast.undo"));
    await waitFor(() => expect(agentLastRun).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByTestId("agentUndoLast.undo")).toBeNull(),
    );
  });
});
