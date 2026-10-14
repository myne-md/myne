// The undo report's SENTENCE (myne-md/myne#850, from the 2026-10-13 review).
//
// `undoResultText` composes what the user is told after an undo, and the settings
// clause was added to it without a test: the reviewer's deletion test found that
// removing the clause failed nothing, because the E2E's undo assertion reads
// `agentReview.undoReport` (AgentReview's own renderer) and mobile cannot reach
// the clause at all today. So the composition and its ORDER were unpinned on the
// one surface that builds them.
//
// The order matters and is the reason this is a test rather than a smoke check:
// the notes come first, then what could not be restored, then what a create left
// behind, and the settings clause sits with the notes because it is the same kind
// of good news. A clause that migrates ahead of the failures would read as "1
// setting put back" over a sentence about what did not come back.

import { describe, expect, it } from "vitest";

import { undoResultText } from "../../src/notes/agent/useUndoLastRun";

/** `t` with the two interpolations this test cares about, and the count carried
 *  through so a wrong count is visible rather than merely a wrong key. */
function t(key: string, opts?: Record<string, unknown>): string {
  const count = opts?.count ?? "";
  return count === "" ? key : `${key}:${count}`;
}

describe("undoResultText", () => {
  it("mentions the settings apart from the notes", () => {
    const text = undoResultText(
      { reverted: 2, failed: [], notesCreatedNotReverted: 0, settingsReverted: 1 },
      t,
    );
    expect(text).toContain("agent.undo.reverted:2");
    expect(text).toContain("agent.undo.revertedSettings:1");
  });

  it("omits the settings clause when no setting was restored", () => {
    // The direction an over-eager clause breaks: a notes-only undo must not claim
    // a setting came back, and `0 settings put back` is a claim.
    const text = undoResultText(
      { reverted: 3, failed: [], notesCreatedNotReverted: 0, settingsReverted: 0 },
      t,
    );
    expect(text).not.toContain("revertedSettings");
  });

  it("reads a settings-only undo as a settings undo", () => {
    // The case the clause exists for: the host restores a preference and no note,
    // which used to render as "0 notes restored" and nothing else.
    const text = undoResultText(
      { reverted: 0, failed: [], notesCreatedNotReverted: 0, settingsReverted: 2 },
      t,
    );
    expect(text).toContain("agent.undo.revertedSettings:2");
  });

  it("keeps the settings clause behind what could not be restored", () => {
    const text = undoResultText(
      {
        reverted: 1,
        failed: ["note-a"],
        notesCreatedNotReverted: 1,
        settingsReverted: 1,
      },
      t,
    );
    // Good news together, then what failed: the settings clause sits with the note
    // count because it is the same kind of news, which is where the implementation
    // puts it. This test first asserted the opposite order.
    expect(text.indexOf("agent.undo.revertedSettings")).toBeLessThan(
      text.indexOf("agent.undo.failed"),
    );
  });
});
