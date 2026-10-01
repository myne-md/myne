// The plain store's state machine (myne-md/myne#788, tasks 5 and 6).
//
// Every assertion drives the real store against a stubbed
// `src/platform/plainFile` seam (the `storeImport.test.ts` pattern), so the
// debounce, the γ2 max timer, the compare-and-swap conflict arms, dormancy and
// the closure gates are exercised without Tauri, a vault or a renderer. Each
// case is written so the behaviour it names regressing makes it fail, not so
// it documents the current shape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  __getPlainStoreStateForTest,
  __resetPlainStoreForTest,
  close,
  dormancyForLock,
  edit,
  flushAll,
  flushForImport,
  handleGateDisabled,
  resolveCopyWithSave,
  resolveOverwrite,
  resolveReload,
  restoreDormant,
  save,
  unsettledTabs,
  upsertOpened,
  type PlainFile,
} from "../../src/plain/store";

const IDLE_MS = 900;

beforeEach(() => {
  __resetPlainStoreForTest();
  writeMock.mockReset();
  readMock.mockReset();
  closeMock.mockReset();
  saveCopyMock.mockReset();
  writeMock.mockResolvedValue("hash-2");
  readMock.mockResolvedValue({ content: "# disk", baseHash: "hash-disk" });
  closeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  __resetPlainStoreForTest();
  vi.useRealTimers();
});

function openOne(content = "# old", baseHash = "hash-1"): void {
  upsertOpened({ handle: 1, name: "note.md", content, baseHash });
}

function openTwo(): void {
  upsertOpened({ handle: 1, name: "one.md", content: "# one", baseHash: "hash-1" });
  upsertOpened({ handle: 2, name: "two.md", content: "# two", baseHash: "hash-2" });
}

function file(handle = 1): PlainFile {
  const found = __getPlainStoreStateForTest().files.find((f) => f.handle === handle);
  if (!found) throw new Error(`no plain file ${handle}`);
  return found;
}

/** Drive a tab into `conflict` through the real save path. */
async function conflicted(options?: { reReadFails?: boolean }): Promise<void> {
  writeMock.mockRejectedValueOnce({ kind: "conflict" });
  if (options?.reReadFails) readMock.mockRejectedValueOnce({ kind: "not_a_file" });
  else readMock.mockResolvedValueOnce({ content: "# theirs", baseHash: "hash-x" });
  openOne();
  edit(1, "# mine");
  await save(1);
}

describe("autosave timing", () => {
  it("coalesces a burst of keystrokes into one write at the idle window", async () => {
    vi.useFakeTimers();
    openOne();
    edit(1, "a");
    await vi.advanceTimersByTimeAsync(IDLE_MS - 100);
    edit(1, "ab");
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(writeMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith(1, "ab", "hash-1");
  });

  it("writes during sustained typing when the max window elapses (γ2)", async () => {
    vi.useFakeTimers();
    openOne();
    edit(1, "v1");
    // 500 ms keystrokes: below the idle window, so the idle timer is re-armed
    // every time and never fires. Only the max clock can land a write, and
    // 25 of them (12.5 s) cross it once, at t = 10000 with `v20` current.
    for (let i = 2; i <= 25; i += 1) {
      await vi.advanceTimersByTimeAsync(500);
      edit(1, `v${i}`);
    }
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0]).toEqual([1, "v20", "hash-1"]);
  });

  it("writes immediately on save, without waiting for the debounce (flush-on-blur)", async () => {
    vi.useFakeTimers();
    openOne();
    edit(1, "typed");
    expect(writeMock).not.toHaveBeenCalled();
    await save(1);
    expect(writeMock).toHaveBeenCalledWith(1, "typed", "hash-1");
    expect(file(1).status).toBe("saved");
  });

  it("schedules exactly one follow-up, with the latest body, when a save lands in flight", async () => {
    vi.useFakeTimers();
    openOne();
    let release: (hash: string) => void = () => undefined;
    writeMock
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce("hash-3");
    edit(1, "first");
    const inFlight = save(1);
    edit(1, "second");
    const joined = save(1);
    release("hash-2");
    await Promise.all([inFlight, joined]);
    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(writeMock.mock.calls[0]).toEqual([1, "first", "hash-1"]);
    // The follow-up carries the newest body and the hash the first write
    // reported, not the one the join saw when it arrived.
    expect(writeMock.mock.calls[1]).toEqual([1, "second", "hash-2"]);
  });
});

describe("conflict arms", () => {
  it("surfaces the banner without writing anything", async () => {
    await conflicted();
    const state = file(1);
    expect(state.status).toBe("conflict");
    expect(state.content).toBe("# mine");
    expect(state.diskContent).toBe("# theirs");
    expect(state.diskBaseHash).toBe("hash-x");
    // The only write attempt is the one the disk refused.
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith(1, "# mine", "hash-1");
  });

  it("keeps the conflict state when the re-read fails, with no disk snapshot", async () => {
    await conflicted({ reReadFails: true });
    const state = file(1);
    expect(state.status).toBe("conflict");
    expect(state.diskContent).toBeUndefined();
    expect(state.diskBaseHash).toBeUndefined();
    expect(unsettledTabs().map((f) => f.handle)).toEqual([1]);
  });

  it("resolveReload adopts the disk snapshot and writes nothing", async () => {
    await conflicted();
    const writesBefore = writeMock.mock.calls.length;
    resolveReload(1);
    const state = file(1);
    expect(state.status).toBe("saved");
    expect(state.content).toBe("# theirs");
    expect(state.baseHash).toBe("hash-x");
    expect(state.diskContent).toBeUndefined();
    expect(writeMock.mock.calls.length).toBe(writesBefore);
    expect(await flushForImport(1)).toBe("# theirs");
  });

  it("resolveOverwrite rebases onto the disk hash and writes the buffer", async () => {
    await conflicted();
    writeMock.mockResolvedValueOnce("hash-y");
    resolveOverwrite(1);
    await vi.waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(2);
    });
    expect(writeMock.mock.calls[1]).toEqual([1, "# mine", "hash-x"]);
    expect(file(1).status).toBe("saved");
  });

  it("the copy arm still works when the re-read failed (no source read needed)", async () => {
    await conflicted({ reReadFails: true });
    saveCopyMock.mockResolvedValueOnce("note copy.md");
    readMock.mockRejectedValueOnce({ kind: "not_a_file" });
    const outcome = await resolveCopyWithSave(1);
    expect(outcome).toBe("saved");
    expect(saveCopyMock).toHaveBeenCalledWith(1, "# mine");
    // The original file is still unresolved; the tab stays for it.
    expect(file(1).status).toBe("conflict");
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("a cancelled copy dialog changes nothing", async () => {
    await conflicted();
    saveCopyMock.mockResolvedValueOnce(null);
    expect(await resolveCopyWithSave(1)).toBe("cancelled");
    expect(file(1).status).toBe("conflict");
  });
});

describe("closure and dormancy", () => {
  it("close drops a settled tab and refuses an unresolved one", async () => {
    openTwo();
    await close(2);
    expect(closeMock).toHaveBeenCalledWith(2);
    expect(__getPlainStoreStateForTest().files.map((f) => f.handle)).toEqual([1]);

    await conflicted();
    await close(1);
    expect(closeMock).not.toHaveBeenCalledWith(1);
    expect(file(1).status).toBe("conflict");
  });

  it("flushes before parking tabs and restores them in the same session", async () => {
    openTwo();
    edit(1, "# one edited");
    await dormancyForLock();
    expect(writeMock).toHaveBeenCalledWith(1, "# one edited", "hash-1");

    let state = __getPlainStoreStateForTest();
    expect(state.files).toEqual([]);
    expect(state.dormant.map((f) => f.handle)).toEqual([1, 2]);
    expect(state.activeHandle).toBeNull();

    restoreDormant();
    state = __getPlainStoreStateForTest();
    expect(state.files.map((f) => f.handle)).toEqual([1, 2]);
    expect(state.dormant).toEqual([]);
    expect(state.activeHandle).toBe(2);
  });

  it("handleGateDisabled closes settled tabs and returns the unresolved ones", async () => {
    openTwo();
    await conflicted();
    expect(unsettledTabs().map((f) => f.handle)).toEqual([1]);

    const remaining = await handleGateDisabled();

    expect(remaining).toEqual([1]);
    expect(closeMock).toHaveBeenCalledWith(2);
    expect(closeMock).not.toHaveBeenCalledWith(1);
    expect(__getPlainStoreStateForTest().files.map((f) => f.handle)).toEqual([1]);
  });

  it("flushAll settles every dirty tab", async () => {
    openTwo();
    edit(1, "# one edited");
    edit(2, "# two edited");
    await flushAll();
    expect(writeMock).toHaveBeenCalledWith(1, "# one edited", "hash-1");
    expect(writeMock).toHaveBeenCalledWith(2, "# two edited", "hash-2");
    expect(file(1).status).toBe("saved");
    expect(file(2).status).toBe("saved");
  });

  it("save is a no-op for a tab already on disk", async () => {
    openOne();
    // `clean`: nothing to write, so blur/flush must not churn the file.
    await save(1);
    expect(writeMock).not.toHaveBeenCalled();

    edit(1, "# typed");
    await save(1);
    expect(writeMock).toHaveBeenCalledTimes(1);

    // Now `saved`; a second save (blur, flushAll, lock, pagehide) must not
    // rewrite byte-identical content.
    await save(1);
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it("a lock parks settled tabs but keeps an unresolved one mounted", async () => {
    openTwo();
    await conflicted(); // handle 1 -> conflict; handle 2 stays settled
    await dormancyForLock();

    const state = __getPlainStoreStateForTest();
    // The unresolved tab is NOT parked: parking removes it from `files`, the
    // surface then unmounts, and the close intercept that guards a quit-while-
    // locked goes with it, so its RAM-only text would be dropped silently.
    expect(state.files.map((f) => f.handle)).toEqual([1]);
    expect(state.dormant.map((f) => f.handle)).toEqual([2]);
    expect(state.activeHandle).toBe(1);
  });

  it("an OS re-open while a tab is parked does not create a second tab", async () => {
    openOne();
    await dormancyForLock();
    expect(__getPlainStoreStateForTest().files).toEqual([]);

    // The OS re-opens the SAME file while the vault is locked (Finder
    // double-click / a second-launch argv).
    upsertOpened({ handle: 1, name: "note.md", content: "# disk", baseHash: "hash-1" });
    expect(__getPlainStoreStateForTest().files).toEqual([]);

    restoreDormant();
    const state = __getPlainStoreStateForTest();
    expect(state.files.map((f) => f.handle)).toEqual([1]);
    expect(state.dormant).toEqual([]);
  });
});
