// @vitest-environment jsdom
//
// Every surface that inherits `flushAll`'s refusal says so (myne-md/myne#520's
// review).
//
// `flushAll` learned to REJECT in this branch, and five call sites inherited
// that rejection without inheriting a decision about it. Four reported nothing
// at all (the inline note rename, the saved-view "Set cover", the template
// convert, and all three task-toggle sites, which additionally produced an
// unhandled rejection out of a `void`), and the fifth attributed EVERY
// rejection to an unsettled pane, including one that can arrive with the rename
// already committed to disk.
//
// The unit under test is the classification, not each screen's toast: a named
// error class is what lets a caller tell "the app declined because your own
// note has not saved" from "the backend failed". Those are different sentences
// and different next actions, and a bare `catch` collapses them.

import { describe, expect, it, vi } from "vitest";
import {
  PanesNotSettledError,
  isPanesNotSettled,
  panesNotSettledMessage,
} from "../../src/notes/workspaceContext";
import { toggleTaskSwallowingRefusal } from "../../src/notes/toggleTask";
import type { VaultTask } from "../../src/notes/taskIndex";

const TASK = {
  noteId: "note-1",
  lineIndex: 0,
  completed: false,
  raw: "- [ ] milk",
  text: "milk",
} as unknown as VaultTask;

describe("PanesNotSettledError", () => {
  it("names the panes rather than counting them", () => {
    const e = new PanesNotSettledError(["pane-a", "pane-b"] as never);
    expect(e.message).toMatch(/2 pane\(s\)/);
    expect(e.message).toContain("pane-a");
    expect(e.message).toContain("pane-b");
    expect(e.panes).toEqual(["pane-a", "pane-b"]);
  });

  it("is distinguishable from any other rejection, in both directions", () => {
    // The whole point of the class. A caller that cannot tell these apart
    // either says nothing about both or names a cause it has not established.
    expect(isPanesNotSettled(new PanesNotSettledError([] as never))).toBe(true);
    expect(isPanesNotSettled(new Error("note_update failed"))).toBe(false);
    expect(isPanesNotSettled("not even an error")).toBe(false);
  });
});

describe("panesNotSettledMessage, the sentence four surfaces were spelling", () => {
  const SENTENCES = { unsettled: "not settled", failed: "it failed" };

  it("picks the refusal sentence for the refusal", () => {
    expect(panesNotSettledMessage(new PanesNotSettledError([] as never), SENTENCES)).toBe(
      "not settled",
    );
  });

  it("picks the failure sentence for anything else, which is the other half", () => {
    // A helper that answered "not settled" to everything would say the app
    // declined about a backend that failed, which is the exact claim the named
    // class exists to stop being made.
    expect(panesNotSettledMessage(new Error("note_update failed"), SENTENCES)).toBe(
      "it failed",
    );
  });
});

describe("the task toggle, which had no classification at all", () => {
  it("swallows a flush refusal instead of leaving an unhandled rejection", async () => {
    // All three call sites are `void toggleTaskSwallowingRefusal(...)`, so an
    // unclassified rejection escapes the promise entirely: a box that does not
    // move and a console error, with nothing connecting the two.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const flush = vi.fn(async () => {
      throw new PanesNotSettledError(["pane-a"] as never);
    });
    await expect(toggleTaskSwallowingRefusal(TASK, flush)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("pane-a"));
    warn.mockRestore();
  });

  it("still propagates anything that is NOT a refusal", async () => {
    // The direction that must not regress: a genuine failure has to stay
    // visible, and a classifier that swallows everything is also wrong.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const flush = vi.fn(async () => {
      throw new Error("IPC transport died");
    });
    await expect(toggleTaskSwallowingRefusal(TASK, flush)).rejects.toThrow(
      "IPC transport died",
    );
    warn.mockRestore();
  });
});
