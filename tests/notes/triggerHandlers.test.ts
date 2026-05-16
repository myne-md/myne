// Unit tests for the inline-rename trigger handlers extracted from
// `src/notes/components/NoteList.tsx`. Covers the keyboard guard
// invariants + the read-then-commit composition.

import { describe, expect, it, vi } from "vitest";

import {
  executeRenameCommit,
  makeF2KeydownHandler,
} from "../../src/notes/components/NoteList";

function ev(key: string): KeyboardEvent {
  // jsdom not loaded by default — fabricate a minimal shape sufficient
  // for the handler.
  return {
    key,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe("makeF2KeydownHandler", () => {
  it("ignores non-F2 keys", () => {
    const startRename = vi.fn();
    const handler = makeF2KeydownHandler({
      selectedId: "id-1",
      renamingId: null,
      startRename,
    });
    handler(ev("Enter"));
    handler(ev("F1"));
    handler(ev("f2")); // case-sensitive — lowercase not a hit
    expect(startRename).not.toHaveBeenCalled();
  });

  it("fires startRename(selectedId) on F2 when conditions met", () => {
    const startRename = vi.fn();
    const handler = makeF2KeydownHandler({
      selectedId: "id-42",
      renamingId: null,
      startRename,
    });
    handler(ev("F2"));
    expect(startRename).toHaveBeenCalledWith("id-42");
    expect(startRename).toHaveBeenCalledTimes(1);
  });

  it("no-ops when no row is selected", () => {
    const startRename = vi.fn();
    const handler = makeF2KeydownHandler({
      selectedId: null,
      renamingId: null,
      startRename,
    });
    handler(ev("F2"));
    expect(startRename).not.toHaveBeenCalled();
  });

  it("no-ops when already in rename mode (avoids re-entering)", () => {
    const startRename = vi.fn();
    const handler = makeF2KeydownHandler({
      selectedId: "id-1",
      renamingId: "id-1",
      startRename,
    });
    handler(ev("F2"));
    expect(startRename).not.toHaveBeenCalled();
  });

  it("calls preventDefault on a successful F2 to suppress browser default", () => {
    const startRename = vi.fn();
    const handler = makeF2KeydownHandler({
      selectedId: "id-1",
      renamingId: null,
      startRename,
    });
    const e = ev("F2");
    handler(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe("executeRenameCommit", () => {
  it("reads current bytes and calls commitRename in order", async () => {
    const read = vi.fn().mockResolvedValueOnce("---\ntitle: Old\n---\n\nbody");
    const commitRename = vi.fn().mockResolvedValueOnce(undefined);
    await executeRenameCommit(
      "id-1",
      "New Title",
      { commitRename },
      read,
    );
    expect(read).toHaveBeenCalledWith("id-1");
    expect(commitRename).toHaveBeenCalledWith(
      "id-1",
      "---\ntitle: Old\n---\n\nbody",
      "New Title",
    );
  });

  it("propagates read failures (caller catches + rolls back)", async () => {
    const read = vi.fn().mockRejectedValueOnce({ kind: "NoteNotFound" });
    const commitRename = vi.fn();
    await expect(
      executeRenameCommit("id-1", "X", { commitRename }, read),
    ).rejects.toMatchObject({ kind: "NoteNotFound" });
    expect(commitRename).not.toHaveBeenCalled();
  });

  it("propagates commitRename failures (sidebarState handles rollback)", async () => {
    const read = vi.fn().mockResolvedValueOnce("body");
    const commitRename = vi
      .fn()
      .mockRejectedValueOnce({ kind: "VaultNotUnlocked" });
    await expect(
      executeRenameCommit("id-1", "X", { commitRename }, read),
    ).rejects.toMatchObject({ kind: "VaultNotUnlocked" });
  });
});
