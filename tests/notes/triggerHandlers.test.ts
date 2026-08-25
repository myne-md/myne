// Unit tests for the inline-rename trigger handlers extracted from
// `src/notes/components/NoteList.tsx`. Covers the keyboard guard
// invariants + the read-then-commit composition.

import { PanesNotSettledError } from "../../src/notes/workspaceContext";
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
  // The ORDER is the assertion, and a return value cannot carry it. This is a
  // read-patch-write against disk on a note that may be open and dirty, so the
  // flush has to happen BEFORE the read or the bytes are the pre-typing ones.
  // `commitRename`'s own flush covers INBOUND notes only, over a list that
  // filters out the renamed note itself, so the renamed note's own pane was
  // never covered.
  it("flushes BEFORE reading, not after and not never", async () => {
    const calls: string[] = [];
    const flush = vi.fn(async () => {
      calls.push("flush");
    });
    const read = vi.fn(async () => {
      calls.push("read");
      return "---\ntitle: Old\n---\n\nbody";
    });
    const commitRename = vi.fn(async () => {
      calls.push("commit");
    });
    await executeRenameCommit("id-1", "New Title", { commitRename }, read, flush);
    expect(calls).toEqual(["flush", "read", "commit"]);
  });

  it("does not read or rename when the flush refuses", async () => {
    // A refused flush means a pane holds unsaved typing. Reading disk anyway
    // would rename over bytes the user has not saved, which is the failure the
    // flush exists to prevent, so the whole thing has to stop here.
    const flush = vi.fn(async () => {
      throw new PanesNotSettledError(["pane-1" as never]);
    });
    const read = vi.fn();
    const commitRename = vi.fn();
    await expect(
      executeRenameCommit("id-1", "X", { commitRename }, read, flush),
    ).rejects.toBeInstanceOf(PanesNotSettledError);
    expect(read).not.toHaveBeenCalled();
    expect(commitRename).not.toHaveBeenCalled();
  });

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
