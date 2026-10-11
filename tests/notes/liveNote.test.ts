// The live-note funnel + lifecycle (`collab-editor-bridge` tasks 7 + 8).
//
// The IPC layer is mocked so the lifecycle logic (attach, refcount, funnel
// fallback) is exercised without a Tauri runtime.

import { beforeEach, describe, expect, it, vi } from "vitest";

const liveSessionOpen = vi.fn<() => Promise<void>>();
const liveSessionClose = vi.fn<() => Promise<void>>();
const liveSessionPatchFrontmatter = vi.fn<(noteId: string, markdown: string) => Promise<void>>();

vi.mock("../../src/lib/live", () => ({
  liveSessionOpen: (...a: []): Promise<void> => liveSessionOpen(...a),
  liveSessionClose: (...a: []): Promise<void> => liveSessionClose(...a),
  liveSessionPatchFrontmatter: (noteId: string, markdown: string): Promise<void> =>
    liveSessionPatchFrontmatter(noteId, markdown),
}));

import {
  closeLiveNote,
  isLiveNote,
  openLiveNote,
  patchLiveNote,
} from "../../src/notes/liveNote";

beforeEach(async () => {
  liveSessionOpen.mockReset().mockResolvedValue(undefined);
  liveSessionClose.mockReset().mockResolvedValue(undefined);
  liveSessionPatchFrontmatter.mockReset().mockResolvedValue(undefined);
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
  it("returns false for a note with no live session", async () => {
    expect(await patchLiveNote("A", "body")).toBe(false);
    expect(liveSessionPatchFrontmatter).not.toHaveBeenCalled();
  });

  it("routes through the session when one is open", async () => {
    await openLiveNote("A");
    expect(await patchLiveNote("A", "body")).toBe(true);
    expect(liveSessionPatchFrontmatter).toHaveBeenCalledWith("A", "body");
  });

  it("falls back and un-tracks when the session went away", async () => {
    await openLiveNote("A");
    liveSessionPatchFrontmatter.mockRejectedValueOnce({ kind: "NotOpen" });
    expect(await patchLiveNote("A", "body")).toBe(false);
    expect(isLiveNote("A")).toBe(false);
  });
});
