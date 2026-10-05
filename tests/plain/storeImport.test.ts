// The plain store's import-to-vault ordering (myne-md/myne#788, task 9).
//
// The store owns the contract the Import action must not get wrong: the flush
// lands BEFORE the note write sees the text, and the tab closes only after the
// note write resolved. Both are asserted through the platform seam mocks and
// the injected `create`, so the spec needs no vault, no Tauri and no renderer.
//
// A conflict at flush is the third case and the one with data-loss shape: the
// file does not hold the buffer, so the import must refuse rather than become
// the only copy of the user's text while the tab still claims a conflict.

import { beforeEach, describe, expect, it, vi } from "vitest";

const writeMock = vi.fn();
const readMock = vi.fn();
const closeMock = vi.fn();
const saveCopyMock = vi.fn();

vi.mock("../../src/platform/plainFile", () => ({
  plainFileWrite: (...args: unknown[]) => writeMock(...args),
  plainFileRead: (...args: unknown[]) => readMock(...args),
  plainFileClose: (...args: unknown[]) => closeMock(...args),
  plainFileSaveCopy: (...args: unknown[]) => saveCopyMock(...args),
  onPlainFileOpened: async () => () => undefined,
  plainFileTakeUnclaimed: async () => [],
}));

import {
  __resetPlainStoreForTest,
  edit,
  flushForImport,
  importToVault,
  resolveCopyWithSave,
  upsertOpened,
} from "../../src/plain/store";

beforeEach(() => {
  __resetPlainStoreForTest();
  writeMock.mockReset();
  readMock.mockReset();
  closeMock.mockReset();
  saveCopyMock.mockReset();
  closeMock.mockResolvedValue(undefined);
});

function openOne(content = "# old", baseHash = "hash-1"): void {
  upsertOpened({ handle: 1, name: "note.md", content, baseHash });
}

describe("importToVault", () => {
  it("flushes before the note write sees the text", async () => {
    const order: string[] = [];
    writeMock.mockImplementation(async () => {
      order.push("write");
      return "hash-2";
    });
    openOne();
    edit(1, "# new");

    const noteId = await importToVault(1, async ({ name, content }) => {
      order.push(`create:${name}:${content}`);
      return "note-1";
    });

    expect(order).toEqual(["write", "create:note.md:# new"]);
    expect(writeMock).toHaveBeenCalledWith(1, "# new", "hash-1");
    expect(noteId).toBe("note-1");
    // The write landed, so the tab may close.
    expect(closeMock).toHaveBeenCalledWith(1);
  });

  it("keeps the tab and the text when the note write fails", async () => {
    writeMock.mockResolvedValue("hash-2");
    openOne();
    edit(1, "# new");

    const result = await importToVault(1, async () => {
      throw new Error("vault locked");
    });

    expect(result).toBeNull();
    expect(closeMock).not.toHaveBeenCalled();
    // The flush did land, and nothing else moved: a retry still has the text.
    expect(await flushForImport(1)).toBe("# new");
  });

  it("flushes a keystroke that lands during the note write before closing", async () => {
    const writes: string[] = [];
    writeMock.mockImplementation(async (_handle: number, content: string) => {
      writes.push(content);
      return `hash-${writes.length}`;
    });
    openOne();
    edit(1, "# new");

    const noteId = await importToVault(1, async ({ content }) => {
      // The user keeps typing while the note write is in flight.
      edit(1, `${content} plus a keystroke`);
      return "note-1";
    });

    expect(noteId).toBe("note-1");
    expect(writes).toEqual(["# new", "# new plus a keystroke"]);
    expect(closeMock).toHaveBeenCalledWith(1);
  });

  it("keeps the tab when a post-import keystroke cannot be flushed", async () => {
    writeMock
      .mockResolvedValueOnce("hash-2")
      .mockRejectedValueOnce({ kind: "conflict" });
    readMock.mockResolvedValue({ content: "# theirs", baseHash: "hash-x" });
    openOne();
    edit(1, "# new");

    const noteId = await importToVault(1, async ({ content }) => {
      edit(1, `${content} raced`);
      return "note-1";
    });

    // The note landed; the tab stays so the banner owns the file's state.
    expect(noteId).toBe("note-1");
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("refuses to import a conflicted buffer", async () => {
    writeMock.mockRejectedValue({ kind: "conflict" });
    readMock.mockResolvedValue({ content: "# theirs", baseHash: "hash-x" });
    openOne();
    edit(1, "# mine");

    const create = vi.fn(async () => "note-1");
    const result = await importToVault(1, create);

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("joins an in-flight write instead of starting a second one", async () => {
    let resolveWrite: (hash: string) => void = () => undefined;
    writeMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    openOne();
    edit(1, "# new");

    const first = flushForImport(1);
    const second = flushForImport(1);
    resolveWrite("hash-2");

    expect(await first).toBe("# new");
    expect(await second).toBe("# new");
    expect(writeMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveCopyWithSave", () => {
  async function conflicted(): Promise<void> {
    writeMock.mockRejectedValue({ kind: "conflict" });
    readMock.mockResolvedValue({ content: "# theirs", baseHash: "hash-x" });
    openOne("# mine");
    edit(1, "# mine");
    await flushForImport(1);
  }

  it("writes the buffer to the chosen copy, then re-reads the original", async () => {
    await conflicted();
    const order: string[] = [];
    saveCopyMock.mockImplementation(async () => {
      order.push("copy");
      return "note copy.md";
    });
    readMock.mockImplementation(async () => {
      order.push("read");
      return { content: "# theirs again", baseHash: "hash-y" };
    });

    const outcome = await resolveCopyWithSave(1);

    expect(outcome).toBe("saved");
    expect(saveCopyMock).toHaveBeenCalledWith(1, "# mine");
    // The buffer is what gets copied, not the disk version.
    expect(order).toEqual(["copy", "read"]);
  });

  it("treats a cancelled dialog as no-op, not failure", async () => {
    await conflicted();
    saveCopyMock.mockResolvedValue(null);
    readMock.mockClear();

    expect(await resolveCopyWithSave(1)).toBe("cancelled");
    // No re-read: the tab is still conflicted and the banner stays.
    expect(readMock).not.toHaveBeenCalled();
  });

  it("reports a refused write as failure and leaves the banner up", async () => {
    await conflicted();
    saveCopyMock.mockRejectedValue({ kind: "io", detail: { io_error_kind: "other" } });
    readMock.mockClear();

    expect(await resolveCopyWithSave(1)).toBe("failed");
    expect(readMock).not.toHaveBeenCalled();
  });
});
