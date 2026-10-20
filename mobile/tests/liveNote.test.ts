// Mobile's live-note wiring (`mobile/src/lib/liveNote.ts`).
//
// The POLICY is tested once, host-free, in `tests/client-core/live-note.test.ts`.
// What this suite covers is the part that is mobile's own: that the shim injects
// this client's bindings and answers, and that the save funnel reaches them
// through the real module path rather than a mock of the policy.
//
// The IPC layer is mocked, the desktop twin's pattern (`tests/notes/liveNote.test.ts`).

import { beforeEach, describe, expect, it, vi } from "vitest";

const liveSessionOpen = vi.fn<(noteId: string) => Promise<void>>();
const liveSessionClose = vi.fn<(noteId: string) => Promise<void>>();
type PatchOpts = { expectedBaseHashHex?: string; base?: string };
const liveSessionPatchFrontmatter =
  vi.fn<(noteId: string, markdown: string, opts?: PatchOpts) => Promise<string>>();
const liveSessionRead = vi.fn<(noteId: string) => Promise<string>>();
const liveSessionTakeRemoteSplices = vi.fn<(noteId: string) => Promise<never[]>>();
const liveSessionSetPresence = vi.fn<
  (
    noteId: string,
    cursor: number | null,
    selection: [number, number] | null,
    label: string | null,
  ) => Promise<void>
>();

// The mock mirrors the WHOLE binding module: the shim reads every binding at
// module init, so a partial mock is a crash rather than a narrower test.
vi.mock("../src/lib/live", () => ({
  liveSessionOpen: (noteId: string): Promise<void> => liveSessionOpen(noteId),
  liveSessionClose: (noteId: string): Promise<void> => liveSessionClose(noteId),
  liveSessionPatchFrontmatter: (
    noteId: string,
    markdown: string,
    opts?: PatchOpts,
  ): Promise<string> => liveSessionPatchFrontmatter(noteId, markdown, opts),
  liveSessionRead: (noteId: string): Promise<string> => liveSessionRead(noteId),
  liveSessionTakeRemoteSplices: (noteId: string): Promise<never[]> =>
    liveSessionTakeRemoteSplices(noteId),
  liveSessionSetPresence: (
    noteId: string,
    cursor: number | null,
    selection: [number, number] | null,
    label: string | null,
  ): Promise<void> => liveSessionSetPresence(noteId, cursor, selection, label),
}));

import {
  closeLiveNote,
  evictLiveNote,
  isLiveNote,
  openLiveNote,
  patchLiveNote,
  reportLivePresence,
  settledPatches,
} from "../src/lib/liveNote";

beforeEach(async () => {
  liveSessionOpen.mockReset().mockResolvedValue(undefined);
  liveSessionClose.mockReset().mockResolvedValue(undefined);
  liveSessionPatchFrontmatter
    .mockReset()
    .mockImplementation(async (_id, markdown) => markdown);
  liveSessionRead.mockReset().mockResolvedValue("");
  liveSessionTakeRemoteSplices.mockReset().mockResolvedValue([]);
  liveSessionSetPresence.mockReset().mockResolvedValue(undefined);
  for (const id of ["A", "B"]) {
    while (isLiveNote(id)) await closeLiveNote(id);
  }
  liveSessionOpen.mockClear();
  liveSessionClose.mockClear();
});

describe("the mobile shim", () => {
  it("opens once and attaches on a second hold of the same note", async () => {
    await openLiveNote("A");
    await openLiveNote("A");
    expect(liveSessionOpen).toHaveBeenCalledTimes(1);
    expect(isLiveNote("A")).toBe(true);
  });

  it("closes only when the last hold is released", async () => {
    await openLiveNote("B");
    await openLiveNote("B");
    await closeLiveNote("B");
    expect(liveSessionClose).not.toHaveBeenCalled();
    await closeLiveNote("B");
    expect(liveSessionClose).toHaveBeenCalledTimes(1);
    expect(isLiveNote("B")).toBe(false);
  });

  it("keeps the durable path when the open fails", async () => {
    liveSessionOpen.mockRejectedValueOnce({ kind: "DrawingNotApplicable" });
    await openLiveNote("A");
    expect(isLiveNote("A")).toBe(false);
  });
});

describe("the save funnel at the real module path", () => {
  it("answers null for a note with no session, so the caller uses note_update", async () => {
    expect(await patchLiveNote("A", "body")).toBeNull();
    expect(liveSessionPatchFrontmatter).not.toHaveBeenCalled();
  });

  it("routes through the session when one is open", async () => {
    await openLiveNote("A");
    expect(await patchLiveNote("A", "body", { expectedBaseHashHex: "h", base: "b" })).toBe("body");
    expect(liveSessionPatchFrontmatter).toHaveBeenCalledWith("A", "body", {
      expectedBaseHashHex: "h",
      base: "b",
    });
  });

  it("hands the caller's onApplied the session's text after the patch", async () => {
    // The editor ignores the value and records the text it SENT (see
    // `LivePatchOptions.onApplied`); the callback's job is the timing: it runs
    // before the patch settles, so a drain waiting on `settledPatches` sees it.
    await openLiveNote("A");
    liveSessionPatchFrontmatter.mockResolvedValueOnce("merged");
    const heard: string[] = [];
    await patchLiveNote("A", "body", { base: "old", onApplied: (text) => heard.push(text) });
    expect(heard).toEqual(["merged"]);
    // The callback stays on this side: the transport receives only its fields.
    const sent = liveSessionPatchFrontmatter.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["base", "onApplied"].sort());
  });

  it("falls back and un-tracks when the session reports not-open", async () => {
    await openLiveNote("A");
    liveSessionPatchFrontmatter.mockRejectedValueOnce({ kind: "NotOpen" });
    expect(await patchLiveNote("A", "body")).toBeNull();
    expect(isLiveNote("A")).toBe(false);
  });
});

describe("evicting through the mobile shim (myne-md/myne#849 review, D7)", () => {
  it("drops every hold with one close through this client's binding", async () => {
    await openLiveNote("A");
    await openLiveNote("A");
    expect(await evictLiveNote("A")).toBe(true);
    expect(liveSessionClose).toHaveBeenCalledTimes(1);
    expect(isLiveNote("A")).toBe(false);
  });
});

describe("settledPatches", () => {
  /** A patch the test resolves or rejects by hand. */
  function heldPatch(): { resolve: (text: string) => void; reject: (e: unknown) => void } {
    const handle = {
      resolve: (_text: string) => {},
      reject: (_e: unknown) => {},
    };
    liveSessionPatchFrontmatter.mockImplementationOnce(
      () =>
        new Promise<string>((resolve, reject) => {
          handle.resolve = resolve;
          handle.reject = reject;
        }),
    );
    return handle;
  }

  /** Whether `p` has settled after the microtask queue drains. */
  async function isSettled(p: Promise<void>): Promise<boolean> {
    let done = false;
    void p.then(() => {
      done = true;
    });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    return done;
  }

  it("stays pending while a patch is in flight and resolves once it lands", async () => {
    await openLiveNote("A");
    const patch = heldPatch();
    const saving = patchLiveNote("A", "body");
    const waiting = settledPatches("A");
    expect(await isSettled(waiting)).toBe(false);
    patch.resolve("body");
    await saving;
    expect(await isSettled(waiting)).toBe(true);
  });

  it("settles, and does not reject, when the patch fails", async () => {
    await openLiveNote("A");
    const patch = heldPatch();
    const saving = patchLiveNote("A", "body");
    const waiting = settledPatches("A");
    expect(await isSettled(waiting)).toBe(false);
    patch.reject({ kind: "Io", detail: "disk full" });
    await expect(saving).rejects.toMatchObject({ kind: "Io" });
    await expect(waiting).resolves.toBeUndefined();
  });

  it("resolves at once when no patch is in flight", async () => {
    expect(await isSettled(settledPatches("A"))).toBe(true);
  });

  it("does not wait for a patch started after the call", async () => {
    // One patch in flight when the drain asks, a second started after: the drain
    // must resolve once the FIRST lands, even though the second never does.
    await openLiveNote("A");
    const first = heldPatch();
    const firstSave = patchLiveNote("A", "first");
    const waiting = settledPatches("A");
    heldPatch(); // never settles
    void patchLiveNote("A", "later").catch(() => {});
    first.resolve("first");
    await firstSave;
    expect(await isSettled(waiting)).toBe(true);
  });
});

describe("presence", () => {
  it("reports the caret through this client's binding for an open note", async () => {
    await openLiveNote("A");
    reportLivePresence("A", 3, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(liveSessionSetPresence).toHaveBeenCalledWith("A", 3, null, null);
  });

  it("is a no-op for a note with no session", async () => {
    reportLivePresence("A", 3, null);
    await Promise.resolve();
    expect(liveSessionSetPresence).not.toHaveBeenCalled();
  });
});
