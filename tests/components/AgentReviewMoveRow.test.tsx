// @vitest-environment jsdom
//
// A move renders as its own row rather than as a diff, and it shows where the
// note is going (myne-md/myne#848).
//
// The row is the half of the move feature a person judges: the verb exists so the
// DESTINATION stops hiding inside a replacement string, and the destination is
// what the `ai_excluded_folders` clamp reads. A diff would render an empty left
// column under "in the note now" and a folder under "after this change", which
// describes nothing, since a folder is not note text.
//
// Keyed on the rendered testids rather than on the prop, the same discipline the
// split-diff test beside this one states: the failure is a row that silently falls
// back to the diff, and nothing else in the tree compares the two.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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

const MOVE: ProposedEdit = {
  noteId: "n1",
  kind: "move",
  // Empty by contract for a move: there is nothing to anchor to, exactly as for
  // an append. `replacement` carries the destination FOLDER.
  anchor: "",
  replacement: "Projects",
};

function settleWith(edits: ProposedEdit[]) {
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
      proposal: { edits, newNotes: [], summary: "s" },
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

function mount(folderOf: (noteId: string) => string | null = () => null) {
  render(
    <AgentReview
      onClose={() => {}}
      onNotesWritten={() => {}}
      titleOf={() => null}
      folderOf={folderOf}
    />,
  );
}

afterEach(() => {
  cleanup();
  clearAgentForLock();
});

describe("the move row", () => {
  it("shows the folder the note is in and the folder it would land in", () => {
    settleWith([MOVE]);
    mount(() => "Work");
    expect(screen.getByTestId("agentReview.moveFrom").textContent).toBe("Work");
    expect(screen.getByTestId("agentReview.moveTo").textContent).toBe("Projects");
  });

  it("is not rendered as a diff, which would describe nothing", () => {
    settleWith([MOVE]);
    mount(() => "Work");
    expect(screen.queryByTestId("diff.view")).toBeNull();
    expect(screen.getByTestId("agentReview.moveFlag").textContent).toBe(
      "agent.review.moveFlag",
    );
  });

  it("names the vault root rather than showing an empty destination", () => {
    // Moving a note to the root is legitimate, and an empty string is how the
    // wire says it. An empty box beside "after this change" would read as a bug.
    settleWith([{ ...MOVE, replacement: "" }]);
    mount(() => "Work");
    expect(screen.getByTestId("agentReview.moveTo").textContent).toBe(
      "agent.review.vaultRoot",
    );
  });

  it("shows the destination alone when the note list does not know the note", () => {
    // `folderOf` resolves from the same note list `titleOf` reads, and that list
    // can be behind (a note created by an earlier run, a list not yet reloaded).
    // The honest answer is the vault root rather than an invented source.
    settleWith([MOVE]);
    mount(() => null);
    expect(screen.getByTestId("agentReview.moveFrom").textContent).toBe(
      "agent.review.vaultRoot",
    );
    expect(screen.getByTestId("agentReview.moveTo").textContent).toBe("Projects");
  });

  it("leaves an ordinary edit on the diff path", () => {
    // The direction a fix aimed at the move case is most likely to break: a
    // replace must keep rendering as a diff.
    settleWith([{ noteId: "n1", anchor: "a", replacement: "b" }]);
    mount(() => "Work");
    expect(screen.getByTestId("diff.view")).toBeDefined();
    expect(screen.queryByTestId("agentReview.moveBody")).toBeNull();
    expect(screen.queryByTestId("agentReview.moveFlag")).toBeNull();
  });
});
