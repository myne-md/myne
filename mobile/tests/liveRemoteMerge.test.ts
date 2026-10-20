// @vitest-environment jsdom
//
// The mobile editor's remote-merge drain (`mobile/src/lib/liveRemoteMerge.ts`,
// myne-md/myne#849 review). A change merged into an OPEN session must reach the
// buffer, or the next whole-markdown save deletes the peer's text.
//
// Three review rounds found the drain wrong in ways that all shared one property:
// the dispatch happened and the BUFFER was wrong. So every case here builds the
// session's text before and after, the buffer the user holds, and asserts the text
// the drain produces, never merely that something was dispatched.
//
// What this file CANNOT reach, stated rather than implied: a real peer's merge.
// The backend has to merge one into the session first, so "a peer's paragraph
// appears" is a device observation and is in the manual roster item.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteSplice } from "../src/lib/liveRemoteMerge";

const seam = vi.hoisted(() => {
  type Handler = (event: { payload: unknown }) => void;
  const handlers = new Map<string, Set<Handler>>();
  return {
    handlers,
    fire(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler({ payload });
    },
    count(event: string) {
      return handlers.get(event)?.size ?? 0;
    },
  };
});

vi.mock("../src/platform/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    const set = seam.handlers.get(event) ?? new Set();
    set.add(handler);
    seam.handlers.set(event, set);
    return Promise.resolve(() => {
      set.delete(handler);
    });
  },
}));

import {
  applySplicesToText,
  diffSplices,
  installRemoteMergeDrain,
  rebaseOnto,
  REMOTE_MERGE_EVENTS,
} from "../src/lib/liveRemoteMerge";

/** Let the registrations and the drain's promise chain land. */
async function settle() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

beforeEach(() => {
  seam.handlers.clear();
});

/**
 * A screen double. `mirror` is what the screen believes the session holds,
 * `session` is what it actually holds, `buffer` is the text on screen. Delivery
 * applies to the buffer exactly as the real screen does with no view mounted.
 */
function harness(
  over: {
    note?: { id: string | null };
    mirror?: string | null;
    session?: string | null;
    buffer?: string;
    deliverThrows?: boolean;
    readRejects?: boolean;
    duringRead?: () => void;
    settled?: () => Promise<void>;
    epoch?: () => number;
    read?: () => Promise<string | null>;
  } = {},
) {
  const holder = over.note ?? { id: "note-a" };
  const state = {
    mirror: over.mirror === undefined ? "hello world\n" : over.mirror,
    session: over.session === undefined ? "hello world\n" : over.session,
    buffer: over.buffer ?? over.mirror ?? "hello world\n",
    took: [] as string[],
    reads: 0,
    delivered: [] as RemoteSplice[][],
    resynced: [] as string[],
  };
  const drain = installRemoteMergeDrain({
    currentNoteId: () => holder.id,
    takeSplices: async (noteId) => {
      state.took.push(noteId);
      return [];
    },
    settled: over.settled ?? (async () => {}),
    patchEpoch: over.epoch ?? (() => 0),
    readSession: async () => {
      if (over.read) {
        state.reads += 1;
        return over.read();
      }
      state.reads += 1;
      over.duringRead?.();
      if (over.readRejects) throw { kind: "Io" };
      return state.session;
    },
    sessionText: (id) => (id === holder.id ? state.mirror : null),
    setSessionText: (_id, text) => {
      state.mirror = text;
    },
    buffer: () => state.buffer,
    deliver: (splices) => {
      if (over.deliverThrows) throw new RangeError("out of range");
      state.delivered.push([...splices]);
      state.buffer = applySplicesToText(state.buffer, splices);
    },
    resync: (id) => {
      state.resynced.push(id);
    },
  });
  return { drain, state, holder };
}

async function fire(id = "note-a") {
  await settle();
  seam.fire("sync://live-remote-merged", id);
  await settle();
}

describe("the drain is wired to both merge events", () => {
  it("subscribes to the durable pull AND the live peer edit", async () => {
    const h = harness();
    await settle();
    for (const name of REMOTE_MERGE_EVENTS) expect(seam.count(name), name).toBe(1);
    h.drain.dispose();
  });

  it("empties the core's queue, then reads the session as the truth", async () => {
    const h = harness({ session: "hello world!\n" });
    await fire();
    expect(h.state.took).toEqual(["note-a"]);
    expect(h.state.buffer).toBe("hello world!\n");
    expect(h.state.mirror).toBe("hello world!\n");
    h.drain.dispose();
  });
});

describe("unsaved local text is kept, and the peer's text lands where they put it", () => {
  it("maps a peer edit over text typed AHEAD of it", async () => {
    const h = harness({ mirror: "hello world\n", session: "hello world!\n", buffer: "Dear hello world\n" });
    await fire();
    expect(h.state.buffer).toBe("Dear hello world!\n");
    expect(h.state.resynced).toEqual([]);
    h.drain.dispose();
  });

  it("maps a peer edit past a local DELETION, which used to throw", async () => {
    const h = harness({ mirror: "hello world\n", session: "hello world!\n", buffer: "hello\n" });
    await fire();
    expect(h.state.buffer).toBe("hello!\n");
    h.drain.dispose();
  });

  it("keeps a peer edit BETWEEN two separate local edits in place", async () => {
    // The adversarial pass's probe: one span over the local edits swallowed the
    // middle and the peer's replacement was moved to the end of the note.
    const mirror = "TOP\nmiddle line PEERDELETE here\nBOTTOM";
    const h = harness({
      mirror,
      session: "TOP\nmiddle line PEERNEW here\nBOTTOM",
      buffer: "TOPx\nmiddle line PEERDELETE here\nBOTTOMy",
    });
    await fire();
    expect(h.state.buffer).toBe("TOPx\nmiddle line PEERNEW here\nBOTTOMy");
    h.drain.dispose();
  });

  it("carries a peer's FRONTMATTER change, which body-clamped splices never did", async () => {
    // A rename lengthens the frontmatter; every later body offset depended on it.
    const fm = (title: string) => `---\ntitle: ${title}\n---\n\nbody text\n`;
    const h = harness({ mirror: fm("A"), session: fm("A much longer title"), buffer: fm("A") + "mine\n" });
    await fire();
    expect(h.state.buffer).toBe(fm("A much longer title") + "mine\n");
    h.drain.dispose();
  });

  it("applies a change that arrives with no view mounted (reading mode)", async () => {
    // The double's delivery IS the string rewrite the screen does with no view.
    const h = harness({ session: "> hello world\n" });
    await fire();
    expect(h.state.buffer).toBe("> hello world\n");
    h.drain.dispose();
  });
});

describe("its own write is not mistaken for a peer's", () => {
  it("waits for this device's in-flight writes before reading the session", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({ session: "hello world!\n", settled: () => gate });
    await fire();
    expect(h.state.reads).toBe(0);
    release();
    await settle();
    expect(h.state.reads).toBe(1);
    h.drain.dispose();
  });

  it("delivers a change once when two events arrive together", async () => {
    // Both reads are held open, so two drains running side by side would both
    // diff the same mirror against the same session and deliver the change twice.
    const gates: (() => void)[] = [];
    const h = harness({
      session: "hello world!\n",
      settled: () =>
        new Promise<void>((r) => {
          gates.push(r);
        }),
    });
    await settle();
    seam.fire("sync://live-remote-merged", "note-a");
    seam.fire("sync://remote-merged", "note-a");
    await settle();
    while (gates.length > 0) {
      for (const g of gates.splice(0)) g();
      await settle();
    }
    expect(h.state.buffer).toBe("hello world!\n");
    expect(h.state.delivered).toHaveLength(1);
    h.drain.dispose();
  });
});

describe("a save that starts after the wait is not read back as a peer's", () => {
  it("reads again when one of this device's writes started during the read", async () => {
    // The user's own save ("mine") starts after `settled` resolved and lands
    // inside the read: the session already holds it and the mirror does not yet,
    // because the patch listener fires after the read returns. Without the epoch
    // check the drain diffs that save as a remote change and the buffer gets it
    // twice (myne-md/myne#849 review round 4).
    let epoch = 0;
    let settles = 0;
    const own = "hello world\nmine\n";
    const h = harness({
      mirror: "hello world\n",
      buffer: own,
      session: "hello world\n",
      epoch: () => epoch,
      settled: async () => {
        settles += 1;
        // The second wait is where the save has finished and its listener has
        // moved the mirror to the text the session returned.
        if (settles === 2) h.state.mirror = own;
      },
      duringRead: () => {
        if (epoch === 0) {
          epoch += 1;
          h.state.session = own;
        }
      },
    });
    await fire();
    expect(h.state.reads).toBe(2);
    expect(h.state.buffer).toBe(own);
    expect(h.state.delivered).toEqual([]);
    h.drain.dispose();
  });
});

describe("drains for one note do not overlap (round 5)", () => {
  it("an older session read resolving late cannot undo a newer merge", async () => {
    // Two events; were the drains concurrent, the first read (older text) could
    // resolve after the second (newer) and be diffed against the advanced mirror,
    // removing the peer's text from the buffer.
    const replies: ((text: string) => void)[] = [];
    const h = harness({
      mirror: "a\n",
      buffer: "a\n",
      read: () =>
        new Promise<string>((r) => {
          replies.push(r);
        }),
    });
    await settle();
    seam.fire("sync://live-remote-merged", "note-a");
    seam.fire("sync://live-remote-merged", "note-a");
    await settle();
    // Serialised: only the first read is in flight.
    expect(replies).toHaveLength(1);
    replies[0]!("a\nb\n");
    await settle();
    expect(replies).toHaveLength(2);
    replies[1]!("a\nb\nc\n");
    await settle();
    expect(h.state.buffer).toBe("a\nb\nc\n");
    h.drain.dispose();
  });
});

describe("a change is never dropped while its note is on screen", () => {
  it("resyncs, rather than swallowing, when delivery throws", async () => {
    const h = harness({ session: "hello world!\n", deliverThrows: true });
    await fire();
    expect(h.state.resynced).toEqual(["note-a"]);
    h.drain.dispose();
  });

  it("resyncs when the screen does not know what the session held", async () => {
    const h = harness({ mirror: null, session: "x\n", buffer: "anything\n" });
    await fire();
    expect(h.state.resynced).toEqual(["note-a"]);
    h.drain.dispose();
  });

  it("leaves the mirror alone when the read fails, so the next event retries", async () => {
    const h = harness({ session: "hello world!\n", readRejects: true });
    await fire();
    expect(h.state.mirror).toBe("hello world\n");
    expect(h.state.resynced).toEqual([]);
    h.drain.dispose();
  });
});

describe("what it must NOT do", () => {
  it("ignores a merge for a note that is not on screen", async () => {
    const h = harness({ session: "changed\n" });
    await fire("note-b");
    expect(h.state.took).toEqual([]);
    h.drain.dispose();
  });

  it("does nothing when the session already matches the mirror", async () => {
    const h = harness();
    await fire();
    expect(h.state.delivered).toEqual([]);
    h.drain.dispose();
  });

  it("does nothing when the session closed meanwhile", async () => {
    const h = harness({ session: null });
    await fire();
    expect(h.state.delivered).toEqual([]);
    expect(h.state.resynced).toEqual([]);
    h.drain.dispose();
  });

  it("does not graft one note's change into another when the screen moved mid-read", async () => {
    const holder: { id: string | null } = { id: "note-a" };
    const h = harness({
      note: holder,
      session: "hello world!\n",
      duringRead: () => {
        holder.id = "note-b";
      },
    });
    await fire();
    expect(h.state.delivered).toEqual([]);
    expect(h.state.resynced).toEqual([]);
    h.drain.dispose();
  });

  it("stops listening and delivering once disposed", async () => {
    const h = harness({ session: "hello world!\n" });
    await settle();
    h.drain.dispose();
    for (const name of REMOTE_MERGE_EVENTS) expect(seam.count(name), name).toBe(0);
    seam.fire("sync://remote-merged", "note-a");
    await settle();
    expect(h.state.delivered).toEqual([]);
  });
});

describe("catchUp", () => {
  it("drains the note on screen with no event, for a pull that landed before the open", async () => {
    const h = harness({ session: "pulled\n" });
    await settle();
    h.drain.catchUp("note-a");
    await settle();
    expect(h.state.buffer).toBe("pulled\n");
    h.drain.dispose();
  });

  it("ignores a note that is no longer on screen", async () => {
    const h = harness({ session: "pulled\n" });
    await settle();
    h.drain.catchUp("note-b");
    await settle();
    expect(h.state.reads).toBe(0);
    h.drain.dispose();
  });
});

describe("diffSplices", () => {
  it("returns separate splices for separate edits", () => {
    expect(diffSplices("a\nb\nc\n", "A\nb\nC\n")).toEqual([
      { from: 0, to: 1, insert: "A" },
      { from: 4, to: 5, insert: "C" },
    ]);
  });

  it("round-trips arbitrary edits", () => {
    const pairs: [string, string][] = [
      ["", "x"],
      ["x", ""],
      ["one\ntwo\nthree", "one\n2\nthree\nfour"],
      ["a😀b\n", "a😃b\n"],
      ["same", "same"],
    ];
    for (const [a, b] of pairs) expect(applySplicesToText(a, diffSplices(a, b))).toBe(b);
  });

  it("never splits a surrogate pair", () => {
    for (const s of diffSplices("a😀b", "a😃b")) {
      expect(s.insert).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  });
});

describe("rebaseOnto", () => {
  it("is the remote change itself when the buffer is unedited", () => {
    const splices = rebaseOnto("abcdef", "abXYef", "abcdef");
    expect(applySplicesToText("abcdef", splices!)).toBe("abXYef");
  });

  it("counts offsets in UTF-16 units across a non-BMP character", () => {
    const splices = rebaseOnto("a😀b", "a😀cb", "Za😀b");
    expect(applySplicesToText("Za😀b", splices!)).toBe("Za😀cb");
  });
});
