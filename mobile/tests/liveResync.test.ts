// The live resync (`mobile/src/lib/liveResync.ts`, myne-md/myne#849 review). It
// runs when the drain could not place a remote change, and it is the branch where
// text gets lost if anything is wrong: the user's unsaved text exists nowhere but
// the buffer, and the session's text is the only copy of the peer's change. So
// every arm here asserts what is LEFT: the buffer, the copy, and the order the two
// were written in.

import { describe, expect, it } from "vitest";
import { runLiveResync, type LiveResyncDeps, type LiveResyncOutcome } from "../src/lib/liveResync";

function harness(over: Partial<LiveResyncDeps> & { buffer0?: string; persisted0?: string | null } = {}) {
  const log: string[] = [];
  const state = {
    noteId: "n" as string | null,
    buffer: over.buffer0 ?? "mine\n",
    copies: new Map<string, string>(),
    rebuiltTo: null as string | null,
    reported: [] as { outcome: LiveResyncOutcome; copyId?: string }[],
  };
  const deps: LiveResyncDeps = {
    currentNoteId: () => state.noteId,
    readSession: async () => "theirs\n",
    readDisk: async () => "disk\n",
    buffer: () => state.buffer,
    persisted: () => (over.persisted0 === undefined ? "old\n" : over.persisted0),
    createCopy: async (text) => {
      log.push("copy");
      state.copies.set("c1", text);
      return "c1";
    },
    updateCopy: async (copyId, text) => {
      log.push("update-copy");
      state.copies.set(copyId, text);
    },
    rebuild: (_id, text) => {
      log.push("rebuild");
      state.rebuiltTo = text;
      state.buffer = text;
    },
    report: (outcome, copyId) => {
      state.reported.push({ outcome, copyId });
    },
    ...over,
  };
  return { deps, state, log };
}

describe("runLiveResync", () => {
  it("keeps unsaved text as a copy BEFORE the buffer is replaced", async () => {
    const h = harness();
    expect(await runLiveResync("n", h.deps)).toBe("reloadedKept");
    expect(h.log).toEqual(["copy", "rebuild"]);
    expect(h.state.copies.get("c1")).toBe("mine\n");
    expect(h.state.buffer).toBe("theirs\n");
    expect(h.state.reported).toEqual([{ outcome: "reloadedKept", copyId: "c1" }]);
  });

  it("rebuilds with no copy when the buffer holds nothing unsaved", async () => {
    const h = harness({ buffer0: "same\n", persisted0: "same\n" });
    expect(await runLiveResync("n", h.deps)).toBe("reloaded");
    expect(h.state.copies.size).toBe(0);
    expect(h.state.buffer).toBe("theirs\n");
  });

  it("leaves the buffer alone when the copy cannot be written", async () => {
    const h = harness({
      createCopy: async () => {
        throw { kind: "Io" };
      },
    });
    expect(await runLiveResync("n", h.deps)).toBe("copyFailed");
    expect(h.state.rebuiltTo).toBeNull();
    expect(h.state.buffer).toBe("mine\n");
  });

  it("leaves the buffer alone when the note cannot be read", async () => {
    const h = harness({
      readSession: async () => {
        throw { kind: "Io" };
      },
    });
    expect(await runLiveResync("n", h.deps)).toBe("readFailed");
    expect(h.state.rebuiltTo).toBeNull();
  });

  it("reads disk when the session closed meanwhile, since closing flushes", async () => {
    const h = harness({ readSession: async () => null, buffer0: "x\n", persisted0: "x\n" });
    await runLiveResync("n", h.deps);
    expect(h.state.buffer).toBe("disk\n");
  });

  it("brings the copy up to date with text typed while it was being written", async () => {
    // The adversarial pass: keystrokes in that window were in neither the copy
    // nor the note.
    const h = harness();
    h.deps.createCopy = async (text) => {
      h.log.push("copy");
      h.state.copies.set("c1", text);
      h.state.buffer = "mine\nand more\n"; // the user kept typing
      return "c1";
    };
    await runLiveResync("n", h.deps);
    expect(h.state.copies.get("c1")).toBe("mine\nand more\n");
    expect(h.log).toEqual(["copy", "update-copy", "rebuild"]);
  });

  it("keeps text typed during the copy's UPDATE too, before replacing the buffer", async () => {
    // Round 5: the update was itself an IPC, and what was typed during it was in
    // neither the copy nor the rebuilt note.
    const h = harness();
    let typed = 0;
    h.deps.createCopy = async (text) => {
      h.state.copies.set("c1", text);
      h.state.buffer = "mine\n1\n";
      return "c1";
    };
    h.deps.updateCopy = async (copyId, text) => {
      h.state.copies.set(copyId, text);
      if (typed === 0) h.state.buffer = "mine\n1\n2\n";
      typed += 1;
    };
    expect(await runLiveResync("n", h.deps)).toBe("reloadedKept");
    expect(h.state.copies.get("c1")).toBe("mine\n1\n2\n");
    expect(h.state.buffer).toBe("theirs\n");
  });

  it("leaves the buffer alone when it will not hold still", async () => {
    const h = harness();
    let n = 0;
    h.deps.updateCopy = async (copyId, text) => {
      h.state.copies.set(copyId, text);
      n += 1;
      h.state.buffer = `mine\n${n}\n`;
    };
    h.deps.createCopy = async (text) => {
      h.state.copies.set("c1", text);
      h.state.buffer = "mine\n0\n";
      return "c1";
    };
    expect(await runLiveResync("n", h.deps)).toBe("copyFailed");
    expect(h.state.rebuiltTo).toBeNull();
  });

  it("does nothing to a screen that moved to another note", async () => {
    const h = harness();
    h.deps.readSession = async () => {
      h.state.noteId = "other";
      return "theirs\n";
    };
    expect(await runLiveResync("n", h.deps)).toBeNull();
    expect(h.state.rebuiltTo).toBeNull();
    expect(h.state.copies.size).toBe(0);
  });
});
