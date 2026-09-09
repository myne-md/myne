import { describe, expect, it } from "vitest";
import { decidePopOutRoute } from "../../src/notes/detachedRoute";

const detached = (...ids: string[]) => {
  const set = new Set(ids);
  return (noteId: string) => set.has(noteId);
};

describe("decidePopOutRoute (SYNC-6 pop-out routing, myne#681 task 3 / #678 task 5)", () => {
  it("spawns when the note is in the main window and not yet detached", () => {
    expect(
      decidePopOutRoute({
        noteId: "n1",
        isDetached: detached(),
        requestingDetachedNoteId: null,
      }),
    ).toBe("spawn");
  });

  it("reveals instead of duplicating when the note is already in a pop-out", () => {
    expect(
      decidePopOutRoute({
        noteId: "n1",
        isDetached: detached("n1", "n2"),
        requestingDetachedNoteId: null,
      }),
    ).toBe("reveal");
  });

  it("suppresses when a detached window asks to pop out its OWN note", () => {
    expect(
      decidePopOutRoute({
        noteId: "n1",
        // Suppress wins over reveal: a pop-out must not re-pop the note it shows.
        isDetached: detached("n1"),
        requestingDetachedNoteId: "n1",
      }),
    ).toBe("suppress");
  });

  it("a detached window revealing a DIFFERENT already-detached note is not suppressed", () => {
    expect(
      decidePopOutRoute({
        noteId: "n2",
        isDetached: detached("n1", "n2"),
        requestingDetachedNoteId: "n1",
      }),
    ).toBe("reveal");
  });

  it("a detached window popping a different, not-yet-detached note spawns it", () => {
    expect(
      decidePopOutRoute({
        noteId: "n3",
        isDetached: detached("n1"),
        requestingDetachedNoteId: "n1",
      }),
    ).toBe("spawn");
  });
});
