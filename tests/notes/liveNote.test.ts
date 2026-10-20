// The live-note funnel + lifecycle (`collab-editor-bridge` tasks 7 + 8).
//
// The IPC layer is mocked so the lifecycle logic (attach, refcount, funnel
// fallback) is exercised without a Tauri runtime.

import { beforeEach, describe, expect, it, vi } from "vitest";

const liveSessionOpen = vi.fn<() => Promise<void>>();
const liveSessionClose = vi.fn<() => Promise<void>>();
const liveSessionPatchFrontmatter = vi.fn<
  (
    noteId: string,
    markdown: string,
    opts?: { expectedBaseHashHex?: string; base?: string },
  ) => Promise<string>
>();
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

// The mock mirrors the WHOLE binding module, not the subset this suite asserts
// on: `src/notes/liveNote.ts` is now a shim over the shared policy and reads
// every binding at module init, so a partial mock is a crash rather than a
// narrower test.
vi.mock("../../src/lib/live", () => ({
  liveSessionOpen: (...a: []): Promise<void> => liveSessionOpen(...a),
  liveSessionClose: (...a: []): Promise<void> => liveSessionClose(...a),
  liveSessionPatchFrontmatter: (
    noteId: string,
    markdown: string,
    opts?: { expectedBaseHashHex?: string; base?: string },
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
  isLiveNote,
  openLiveNote,
  patchLiveNote,
  readLiveNote,
} from "../../src/notes/liveNote";

beforeEach(async () => {
  liveSessionOpen.mockReset().mockResolvedValue(undefined);
  liveSessionClose.mockReset().mockResolvedValue(undefined);
  liveSessionPatchFrontmatter
    .mockReset()
    .mockImplementation(async (_id, markdown) => markdown);
  liveSessionRead.mockReset().mockResolvedValue("session text");
  // Release every hold a prior test left behind.
  for (const id of ["A", "B", "C"]) {
    while (isLiveNote(id)) await closeLiveNote(id);
  }
  liveSessionOpen.mockClear();
  liveSessionClose.mockClear();
});

describe("openLiveNote / closeLiveNote", () => {
  it("opens once and ATTACHES on a second hold of the same note", async () => {
    await openLiveNote("A");
    await openLiveNote("A"); // a second pane showing the same note
    expect(liveSessionOpen).toHaveBeenCalledTimes(1);
    expect(isLiveNote("A")).toBe(true);
  });

  it("closes only when the LAST hold is released", async () => {
    await openLiveNote("B");
    await openLiveNote("B");
    await closeLiveNote("B"); // one pane closes
    expect(liveSessionClose).not.toHaveBeenCalled();
    expect(isLiveNote("B")).toBe(true);
    await closeLiveNote("B"); // the last pane closes
    expect(liveSessionClose).toHaveBeenCalledTimes(1);
    expect(isLiveNote("B")).toBe(false);
  });

  it("stays on the durable path when the open fails (drawing / locked)", async () => {
    liveSessionOpen.mockRejectedValueOnce({ kind: "DrawingNotApplicable" });
    await openLiveNote("C");
    expect(isLiveNote("C")).toBe(false);
  });
});

describe("patchLiveNote (the save funnel)", () => {
  it("returns null for a note with no live session", async () => {
    expect(await patchLiveNote("A", "body")).toBeNull();
    expect(liveSessionPatchFrontmatter).not.toHaveBeenCalled();
  });

  it("routes through the session when one is open", async () => {
    await openLiveNote("A");
    expect(await patchLiveNote("A", "body")).toBe("body");
    expect(liveSessionPatchFrontmatter).toHaveBeenCalledWith("A", "body", undefined);
  });

  it("falls back and un-tracks when the session went away", async () => {
    await openLiveNote("A");
    liveSessionPatchFrontmatter.mockRejectedValueOnce({ kind: "NotOpen" });
    expect(await patchLiveNote("A", "body")).toBeNull();
    expect(isLiveNote("A")).toBe(false);
  });
});

describe("readLiveNote (myne-md/myne#849 review, D8)", () => {
  it("answers null with no IPC for a note no session owns", async () => {
    expect(await readLiveNote("A")).toBeNull();
    expect(liveSessionRead).not.toHaveBeenCalled();
  });

  it("reads the session's text while one is open", async () => {
    await openLiveNote("A");
    expect(await readLiveNote("A")).toBe("session text");
    expect(liveSessionRead).toHaveBeenCalledWith("A");
  });

  it("answers null when the session closed underneath the read", async () => {
    await openLiveNote("A");
    liveSessionRead.mockRejectedValueOnce({ kind: "NotOpen" });
    expect(await readLiveNote("A")).toBeNull();
  });

  it("rethrows any other failure", async () => {
    await openLiveNote("A");
    liveSessionRead.mockRejectedValueOnce({ kind: "Io", detail: "boom" });
    await expect(readLiveNote("A")).rejects.toMatchObject({ kind: "Io" });
  });
});
