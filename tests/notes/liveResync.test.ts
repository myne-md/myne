// The desktop pane's live resync (`src/notes/liveResync.ts`, myne-md/myne#849
// review round 5). Every arm asserts what is LEFT: the buffer, the mirror, and
// whether the user was told.

import { describe, expect, it } from "vitest";
import { runPaneResync, type PaneResyncDeps } from "../../src/notes/liveResync";

function harness(over: Partial<PaneResyncDeps> = {}) {
  const log: string[] = [];
  const deps: PaneResyncDeps = {
    stillOn: () => true,
    hasPendingWork: () => false,
    keepBoth: async () => {
      log.push("keepBoth");
    },
    readSession: async () => "theirs\n",
    adopt: (text) => log.push(`adopt:${text}`),
    forgetMirror: () => log.push("forgetMirror"),
    reportFailure: () => log.push("reportFailure"),
    ...over,
  };
  return { deps, log };
}

describe("runPaneResync", () => {
  it("rebuilds a clean buffer from the session", async () => {
    const h = harness();
    expect(await runPaneResync(h.deps)).toBe("reloaded");
    expect(h.log).toEqual(["adopt:theirs\n"]);
  });

  it("sends a dirty buffer through keep-both instead of replacing it", async () => {
    const h = harness({ hasPendingWork: () => true });
    expect(await runPaneResync(h.deps)).toBe("keptBoth");
    expect(h.log).toEqual(["keepBoth"]);
  });

  it("forgets the mirror and TELLS the user when the read fails", async () => {
    const h = harness({
      readSession: async () => {
        throw { kind: "Io" };
      },
    });
    expect(await runPaneResync(h.deps)).toBe("readFailed");
    expect(h.log).toEqual(["forgetMirror", "reportFailure"]);
  });

  it("forgets the mirror and tells the user when keep-both fails", async () => {
    const h = harness({
      hasPendingWork: () => true,
      keepBoth: async () => {
        throw new Error("copy failed");
      },
    });
    expect(await runPaneResync(h.deps)).toBe("readFailed");
    expect(h.log).toEqual(["forgetMirror", "reportFailure"]);
  });

  it("does not replace text typed during the read", async () => {
    let typed = false;
    const h = harness({
      hasPendingWork: () => typed,
      readSession: async () => {
        typed = true;
        return "theirs\n";
      },
    });
    expect(await runPaneResync(h.deps)).toBe("keptBoth");
    expect(h.log).toEqual(["keepBoth"]);
  });

  it("does nothing for a pane that moved to another note", async () => {
    const h = harness({ stillOn: () => false });
    expect(await runPaneResync(h.deps)).toBeNull();
    expect(h.log).toEqual([]);
  });
});
