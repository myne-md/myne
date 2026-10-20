// The shared live-note policy (`client-core/src/live-note.ts`).
//
// The host is a FAKE, injected through the seam, so this suite runs with no
// Tauri runtime and no module mocking. That is the point of the seam: the
// policy is host-free by construction, so its tests drive it directly.
//
// The behavioural half of the same contract stays at
// `tests/notes/liveNote.test.ts`, which drives the desktop shim over the real
// binding paths.

import { beforeEach, describe, expect, it } from "vitest";
import {
  createLiveNotePolicy,
  type LiveNoteHost,
  type LivePatchOptions,
  type LocalSplice,
} from "../../client-core/src/live-note";

/** A host whose every call is recorded, so the assertions read the seam. */
function fakeHost(overrides: Partial<LiveNoteHost> = {}): LiveNoteHost & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    open: async (noteId: string) => {
      calls.push(`open:${noteId}`);
    },
    close: async (noteId: string) => {
      calls.push(`close:${noteId}`);
    },
    patch: async (noteId: string, markdown: string, opts?: LivePatchOptions) => {
      calls.push(`patch:${noteId}:${markdown}${opts === undefined ? "" : `:${JSON.stringify(opts)}`}`);
      return `session:${markdown}`;
    },
    takeRemoteSplices: async (noteId: string): Promise<LocalSplice[]> => {
      calls.push(`splices:${noteId}`);
      return [];
    },
    setPresence: async (
      noteId: string,
      cursor: number | null,
      selection: [number, number] | null,
      label: string | null,
    ) => {
      calls.push(`presence:${noteId}:${cursor}:${JSON.stringify(selection)}:${label}`);
    },
    peerPresenceAvailable: () => true,
    awarenessCursorsAvailable: () => true,
    ...overrides,
  };
}

let host: ReturnType<typeof fakeHost>;
let policy: ReturnType<typeof createLiveNotePolicy>;

beforeEach(() => {
  host = fakeHost();
  policy = createLiveNotePolicy(host);
});

describe("a save landing inside an in-flight open (myne-md/myne#849 review)", () => {
  it("waits for the open and retries, rather than falling back to a refused write", async () => {
    // The window the refcount creates: `openLiveNote` counts OPTIMISTICALLY before
    // `host.open` resolves, so a save in the same tick reaches `patch` while the
    // registry has no session yet and answers NotOpen. Read as "no session", that
    // answer un-tracked the note and sent the caller to a stateless write which the
    // registry then REFUSED, because the open had landed in between.
    let sessionOpen = false;
    let resolveOpen: (() => void) | null = null;
    let patchAttempts = 0;
    host = fakeHost({
      open: async (noteId: string) => {
        host.calls.push(`open:${noteId}`);
        await new Promise<void>((resolve) => {
          resolveOpen = resolve;
        });
        sessionOpen = true;
      },
      patch: async (noteId: string, markdown: string) => {
        patchAttempts += 1;
        host.calls.push(`patch:${noteId}:${markdown}`);
        if (!sessionOpen) throw { kind: "NotOpen" };
        return markdown;
      },
    });
    policy = createLiveNotePolicy(host);

    const opening = policy.openLiveNote("n");
    // The save races the open, exactly as a background flush does.
    const saving = policy.patchLiveNote("n", "body");
    resolveOpen!();
    await opening;

    // The retry is what makes this true; without it the first NotOpen would have
    // released the hold and answered false.
    await expect(saving).resolves.toBe("body");
    expect(patchAttempts).toBe(2);
  });

  it("still releases the hold and falls back when the open genuinely failed", async () => {
    host = fakeHost({
      open: async () => {
        throw { kind: "HardwareUnavailable" };
      },
      patch: async () => {
        throw { kind: "NotOpen" };
      },
    });
    policy = createLiveNotePolicy(host);

    await policy.openLiveNote("n");
    // The open released its own hold, so the note is not tracked and the caller
    // takes the durable path rather than being told a session exists.
    await expect(policy.patchLiveNote("n", "body")).resolves.toBeNull();
    expect(policy.isLiveNote("n")).toBe(false);
  });

  it("waits out an in-flight open before closing, so the close lands on the session it created", async () => {
    // The other half of the same window (myne-md/myne#849 review): a close that
    // lands while `host.open` is still in flight would call `host.close` against a
    // session the backend has not created, take the `NotOpen` arm and return,
    // leaving the open to land with no hold tracking it. Every later save is then
    // refused as a stateless write beside a live session.
    let sessionOpen = false;
    let resolveOpen: (() => void) | null = null;
    let closes = 0;
    host = fakeHost({
      open: async (noteId: string) => {
        host.calls.push(`open:${noteId}`);
        await new Promise<void>((resolve) => {
          resolveOpen = resolve;
        });
        sessionOpen = true;
      },
      close: async (noteId: string) => {
        host.calls.push(`close:${noteId}`);
        if (!sessionOpen) throw { kind: "NotOpen" };
        sessionOpen = false;
        closes += 1;
      },
    });
    policy = createLiveNotePolicy(host);

    const opening = policy.openLiveNote("A");
    const closing = policy.closeLiveNote("A"); // the view unmounts mid-open
    resolveOpen!();
    await opening;
    await closing;

    // The session the open created is the one the close tore down; the close did
    // not run early and no-op against a session that did not exist yet.
    expect(closes).toBe(1);
    expect(sessionOpen).toBe(false);
    expect(policy.isLiveNote("A")).toBe(false);
  });
});

describe("the refcount", () => {
  it("opens once and ATTACHES on a second hold of the same note", async () => {
    await policy.openLiveNote("A");
    await policy.openLiveNote("A"); // a second view of the same note
    expect(host.calls.filter((c) => c === "open:A")).toHaveLength(1);
    expect(policy.isLiveNote("A")).toBe(true);
  });

  it("closes only when the LAST hold is released", async () => {
    await policy.openLiveNote("B");
    await policy.openLiveNote("B");
    await policy.closeLiveNote("B"); // one view closes
    expect(host.calls).not.toContain("close:B");
    expect(policy.isLiveNote("B")).toBe(true);
    await policy.closeLiveNote("B"); // the last view closes
    expect(host.calls.filter((c) => c === "close:B")).toHaveLength(1);
    expect(policy.isLiveNote("B")).toBe(false);
  });

  it("ignores a release for a note it never held", async () => {
    await policy.closeLiveNote("C");
    expect(host.calls).not.toContain("close:C");
  });

  it("keeps notes independent of each other", async () => {
    await policy.openLiveNote("A");
    await policy.openLiveNote("B");
    await policy.closeLiveNote("A");
    expect(policy.isLiveNote("A")).toBe(false);
    expect(policy.isLiveNote("B")).toBe(true);
  });
});

describe("a close whose flush fails (myne-md/myne#849 review)", () => {
  it("re-arms the hold, so the next save still routes through the session", async () => {
    // The core removes a session from its registry only on a successful flush, so
    // a failed close leaves the session in place. Dropping the hold anyway told
    // every later save "there is no session", and the stateless write it then took
    // is refused by the registry. Asserted as STATE: the note is still live, and the
    // next save reaches `host.patch` rather than returning false.
    host = fakeHost({
      close: async (noteId: string) => {
        host.calls.push(`close:${noteId}`);
        throw { kind: "Io", detail: "disk full" };
      },
    });
    policy = createLiveNotePolicy(host);
    await policy.openLiveNote("n");
    await policy.closeLiveNote("n");
    expect(policy.isLiveNote("n")).toBe(true);
    expect(await policy.patchLiveNote("n", "body")).toBe("session:body");
    expect(host.calls).toContain("patch:n:body");
  });

  it("does NOT re-arm when the close says the session is already gone", async () => {
    host = fakeHost({
      close: async () => {
        throw { kind: "NotOpen" };
      },
    });
    policy = createLiveNotePolicy(host);
    await policy.openLiveNote("n");
    await policy.closeLiveNote("n");
    expect(policy.isLiveNote("n")).toBe(false);
  });
});

describe("opening", () => {
  it("holds the note OPTIMISTICALLY, so a save in the same tick routes to the session", async () => {
    let release: (() => void) | undefined;
    const pending = fakeHost({
      open: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const p = createLiveNotePolicy(pending);
    const opening = p.openLiveNote("A");
    // The open has NOT resolved yet, and the save must still route to it:
    // otherwise a keystroke landing in the same tick goes to the stateless
    // path and the backend refuses it.
    expect(p.isLiveNote("A")).toBe(true);
    expect(await p.patchLiveNote("A", "body")).toBe("session:body");
    release?.();
    await opening;
  });

  it("releases the hold when the open fails, so the durable path resumes", async () => {
    const failing = fakeHost({
      open: async () => {
        throw { kind: "DrawingNotApplicable" };
      },
    });
    const p = createLiveNotePolicy(failing);
    await p.openLiveNote("C");
    expect(p.isLiveNote("C")).toBe(false);
  });

  it("does nothing at all when the client has no peer-presence capability", async () => {
    const noPresence = fakeHost({ peerPresenceAvailable: () => false });
    const p = createLiveNotePolicy(noPresence);
    await p.openLiveNote("A");
    expect(noPresence.calls).toHaveLength(0);
    expect(p.isLiveNote("A")).toBe(false);
  });
});

describe("the save funnel", () => {
  it("returns false for a note with no live session, and does not touch the host", async () => {
    expect(await policy.patchLiveNote("A", "body")).toBeNull();
    expect(host.calls).toHaveLength(0);
  });

  it("routes through the session when one is open", async () => {
    await policy.openLiveNote("A");
    host.calls.length = 0;
    expect(await policy.patchLiveNote("A", "body")).toBe("session:body");
    expect(host.calls).toEqual(["patch:A:body"]);
  });

  it("falls back and un-tracks when the session reports not-open", async () => {
    const gone = fakeHost({
      patch: async () => {
        throw { kind: "NotOpen" };
      },
    });
    const p = createLiveNotePolicy(gone);
    await p.openLiveNote("A");
    expect(await p.patchLiveNote("A", "body")).toBeNull();
    expect(p.isLiveNote("A")).toBe(false);
  });

  it("propagates a failure that is not a closed session", async () => {
    const bad = fakeHost({
      patch: async () => {
        throw new Error("disk on fire");
      },
    });
    const p = createLiveNotePolicy(bad);
    await p.openLiveNote("A");
    await expect(p.patchLiveNote("A", "body")).rejects.toThrow("disk on fire");
    expect(p.isLiveNote("A")).toBe(true);
  });
});

describe("the save funnel's guards (myne-md/myne#849 review, D8)", () => {
  it("forwards the expected-base hash and the base to the session", async () => {
    await policy.openLiveNote("A");
    host.calls.length = 0;
    await policy.patchLiveNote("A", "body", { expectedBaseHashHex: "abc", base: "old" });
    expect(host.calls).toEqual(['patch:A:body:{"expectedBaseHashHex":"abc","base":"old"}']);
  });

  it("answers with the session's text after the patch, not the text sent", async () => {
    // After a merge the two differ, and a caller mirroring the session must see
    // the merged text.
    const merging = fakeHost({ patch: async () => "merged" });
    const p = createLiveNotePolicy(merging);
    await p.openLiveNote("A");
    expect(await p.patchLiveNote("A", "body", { base: "old" })).toBe("merged");
  });

  it("propagates a BaseMismatch and keeps the hold, rather than reading it as no session", async () => {
    // Read as NotOpen it would release the hold and send the caller to a stateless
    // write, which drops the guard AND is refused beside the live session.
    const guarded = fakeHost({
      patch: async () => {
        throw { kind: "BaseMismatch" };
      },
    });
    const p = createLiveNotePolicy(guarded);
    await p.openLiveNote("A");
    await expect(
      p.patchLiveNote("A", "body", { expectedBaseHashHex: "stale" }),
    ).rejects.toMatchObject({ kind: "BaseMismatch" });
    expect(p.isLiveNote("A")).toBe(true);
  });
});

describe("evicting a session (myne-md/myne#849 review, D7)", () => {
  it("clears a count of two in one call and closes once", async () => {
    await policy.openLiveNote("A");
    await policy.openLiveNote("A");
    host.calls.length = 0;
    expect(await policy.evictLiveNote("A")).toBe(true);
    expect(host.calls).toEqual(["close:A"]);
    expect(policy.isLiveNote("A")).toBe(false);
    // The two views' own releases then find nothing and close nothing.
    await policy.closeLiveNote("A");
    await policy.closeLiveNote("A");
    expect(host.calls).toEqual(["close:A"]);
  });

  it("restores the WHOLE count when the flush fails", async () => {
    host = fakeHost({
      close: async (noteId: string) => {
        host.calls.push(`close:${noteId}`);
        throw { kind: "Io", detail: "disk full" };
      },
    });
    policy = createLiveNotePolicy(host);
    await policy.openLiveNote("A");
    await policy.openLiveNote("A");
    expect(await policy.evictLiveNote("A")).toBe(false);
    expect(policy.isLiveNote("A")).toBe(true);
    // Both holds came back: the first release only decrements, so no close is
    // attempted until the second.
    host.calls.length = 0;
    await policy.closeLiveNote("A");
    expect(host.calls).toEqual([]);
    expect(policy.isLiveNote("A")).toBe(true);
  });

  it("adds the restored count to a hold taken while the close was in flight", async () => {
    let rejectClose: ((e: unknown) => void) | null = null;
    host = fakeHost({
      close: (noteId: string) => {
        host.calls.push(`close:${noteId}`);
        // Only the evict's close is held open; a later one settles at once, so a
        // miscounted release fails the assertion below rather than hanging.
        if (rejectClose !== null) return Promise.resolve();
        return new Promise<void>((_, reject) => {
          rejectClose = reject;
        });
      },
    });
    policy = createLiveNotePolicy(host);
    await policy.openLiveNote("A");
    await policy.openLiveNote("A");
    const evicting = policy.evictLiveNote("A");
    await Promise.resolve();
    await policy.openLiveNote("A"); // a view opens the note mid-evict
    rejectClose!({ kind: "Io", detail: "disk full" });
    expect(await evicting).toBe(false);
    host.calls.length = 0;
    // Three holds now: two restored plus the new one. Two releases close nothing.
    await policy.closeLiveNote("A");
    await policy.closeLiveNote("A");
    expect(host.calls.filter((c) => c === "close:A")).toHaveLength(0);
    expect(policy.isLiveNote("A")).toBe(true);
  });

  it("counts a NotOpen close as evicted", async () => {
    host = fakeHost({
      close: async () => {
        throw { kind: "NotOpen" };
      },
    });
    policy = createLiveNotePolicy(host);
    await policy.openLiveNote("A");
    expect(await policy.evictLiveNote("A")).toBe(true);
    expect(policy.isLiveNote("A")).toBe(false);
  });

  it("is a no-op returning true for a note it does not hold", async () => {
    expect(await policy.evictLiveNote("A")).toBe(true);
    expect(host.calls).toHaveLength(0);
  });

  it("waits out an in-flight open, so the session it creates is the one it closes", async () => {
    let sessionOpen = false;
    let resolveOpen: (() => void) | null = null;
    host = fakeHost({
      open: async () => {
        await new Promise<void>((resolve) => {
          resolveOpen = resolve;
        });
        sessionOpen = true;
      },
      close: async (noteId: string) => {
        host.calls.push(`close:${noteId}`);
        if (!sessionOpen) throw { kind: "NotOpen" };
        sessionOpen = false;
      },
    });
    policy = createLiveNotePolicy(host);
    const opening = policy.openLiveNote("A");
    const evicting = policy.evictLiveNote("A");
    resolveOpen!();
    await opening;
    expect(await evicting).toBe(true);
    expect(sessionOpen).toBe(false);
    expect(policy.isLiveNote("A")).toBe(false);
  });
});

describe("remote splices", () => {
  it("hands back nothing for a note with no live session", async () => {
    expect(await policy.takeRemoteSplices("A")).toEqual([]);
    expect(host.calls).toHaveLength(0);
  });

  it("drains through the session when one is open", async () => {
    const withSplices = fakeHost({
      takeRemoteSplices: async (): Promise<LocalSplice[]> => [
        { from: 1, to: 2, insert: "x" },
      ],
    });
    const p = createLiveNotePolicy(withSplices);
    await p.openLiveNote("A");
    expect(await p.takeRemoteSplices("A")).toEqual([{ from: 1, to: 2, insert: "x" }]);
  });
});

describe("presence reporting", () => {
  it("reports the caret for an open note", async () => {
    await policy.openLiveNote("A");
    host.calls.length = 0;
    policy.reportLivePresence("A", 4, [2, 6]);
    await Promise.resolve();
    expect(host.calls).toEqual(["presence:A:4:[2,6]:null"]);
  });

  it("is a no-op for a note with no live session", async () => {
    policy.reportLivePresence("A", 4, null);
    await Promise.resolve();
    expect(host.calls).toHaveLength(0);
  });

  it("is a no-op when the client has no awareness-cursor capability", async () => {
    const noCursors = fakeHost({ awarenessCursorsAvailable: () => false });
    const p = createLiveNotePolicy(noCursors);
    await p.openLiveNote("A");
    noCursors.calls.length = 0;
    p.reportLivePresence("A", 4, null);
    await Promise.resolve();
    expect(noCursors.calls).toHaveLength(0);
  });

  it("never throws when the host rejects the report", async () => {
    const rejecting = fakeHost({
      setPresence: async () => {
        throw new Error("stream gone");
      },
    });
    const p = createLiveNotePolicy(rejecting);
    await p.openLiveNote("A");
    expect(() => p.reportLivePresence("A", 4, null)).not.toThrow();
    await Promise.resolve();
  });
});

describe("the seam is per instance", () => {
  it("keeps two policies over the same id independent", async () => {
    const other = fakeHost();
    const p2 = createLiveNotePolicy(other);
    await policy.openLiveNote("A");
    expect(p2.isLiveNote("A")).toBe(false);
    expect(other.calls).toHaveLength(0);
  });
});

describe("what a merge drain needs from the funnel (myne-md/myne#849 review round 4)", () => {
  it("runs the caller's onApplied with the session's text BEFORE the patch settles", async () => {
    await policy.openLiveNote("A");
    const order: string[] = [];
    const call = policy.patchLiveNote("A", "body", {
      onApplied: (after) => order.push(`applied:${after}`),
    });
    const settled = policy.settledPatches("A").then(() => order.push("settled"));
    await Promise.all([call, settled]);
    expect(order).toEqual(["applied:session:body", "settled"]);
  });

  it("does not run onApplied when the write took the stateless path", async () => {
    const heard: string[] = [];
    expect(await policy.patchLiveNote("A", "body", { onApplied: (t) => heard.push(t) })).toBeNull();
    expect(heard).toEqual([]);
  });

  it("counts each patch that STARTS, so a reader can tell one overlapped it", async () => {
    await policy.openLiveNote("A");
    expect(policy.patchEpoch("A")).toBe(0);
    const call = policy.patchLiveNote("A", "one");
    // Counted at the start, not on settle: the drain compares it across a read
    // the patch may still be inside.
    expect(policy.patchEpoch("A")).toBe(1);
    await call;
    await policy.patchLiveNote("A", "two");
    expect(policy.patchEpoch("A")).toBe(2);
    expect(policy.patchEpoch("B")).toBe(0);
  });

  it("settledPatches waits for a patch in flight and resolves at once with none", async () => {
    let release!: (text: string) => void;
    host = fakeHost({
      patch: () =>
        new Promise<string>((r) => {
          release = r;
        }),
    });
    policy = createLiveNotePolicy(host);
    await policy.openLiveNote("A");
    await policy.settledPatches("A");
    const call = policy.patchLiveNote("A", "body");
    let done = false;
    const waited = policy.settledPatches("A").then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    release("s");
    await Promise.all([call, waited]);
    expect(done).toBe(true);
  });
});
