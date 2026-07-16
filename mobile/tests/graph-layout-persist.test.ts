// The persistence plumbing's mobile-specific behaviors: the once-per-session
// hydration latch, the debounced flush, the post-lock no-op guard, and the
// lock-reset re-arming the latch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  __resetGraphLayoutPersistForTest,
  ensureGraphLayoutHydrated,
  flushGraphLayoutNow,
  resetGraphLayoutOnLock,
  scheduleGraphLayoutFlush,
} from "../src/lib/graph-layout-persist";
import {
  __resetGraphLayoutForTest,
  getGraphPosition,
  hasGraphLayout,
  setGraphPositions,
} from "../src/lib/graph-layout-store";

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
});

afterEach(() => {
  __resetGraphLayoutPersistForTest();
  __resetGraphLayoutForTest();
  vi.useRealTimers();
});

describe("ensureGraphLayoutHydrated", () => {
  it("reads the blob once per session; remounts are store-served", async () => {
    invokeMock.mockResolvedValue(JSON.stringify({ v: 1, pos: [["n1", 5, 6]] }));
    expect(await ensureGraphLayoutHydrated()).toBe(true);
    expect(getGraphPosition("n1")).toEqual({ x: 5, y: 6 });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Second mount: no IPC, and in-memory positions newer than disk survive.
    setGraphPositions([{ id: "n1", x: 99, y: 99 }]);
    expect(await ensureGraphLayoutHydrated()).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(getGraphPosition("n1")).toEqual({ x: 99, y: 99 });
  });

  it("collapses a read failure to empty-store (§9.19.4), not an error", async () => {
    invokeMock.mockRejectedValue(new Error("slot locked"));
    expect(await ensureGraphLayoutHydrated()).toBe(false);
    expect(hasGraphLayout()).toBe(false);
  });

  it("lock reset re-arms the latch for the next session", async () => {
    invokeMock.mockResolvedValue(null);
    await ensureGraphLayoutHydrated();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    resetGraphLayoutOnLock();
    invokeMock.mockResolvedValue(JSON.stringify({ v: 1, pos: [["n2", 1, 2]] }));
    expect(await ensureGraphLayoutHydrated()).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(getGraphPosition("n2")).toEqual({ x: 1, y: 2 });
  });
});

describe("flush", () => {
  it("debounces rapid schedules into one write", async () => {
    invokeMock.mockResolvedValue(undefined);
    setGraphPositions([{ id: "a", x: 1, y: 2 }]);
    scheduleGraphLayoutFlush();
    scheduleGraphLayoutFlush();
    scheduleGraphLayoutFlush();
    await vi.advanceTimersByTimeAsync(900);
    const writes = invokeMock.mock.calls.filter(
      (c) => c[0] === "plugin:graph-layout|graph_layout_write",
    );
    expect(writes).toHaveLength(1);
    expect(JSON.parse((writes[0][1] as { payload: string }).payload)).toEqual({
      v: 1,
      pos: [["a", 1, 2]],
    });
  });

  it("flushGraphLayoutNow cancels the debounce and writes immediately", async () => {
    invokeMock.mockResolvedValue(undefined);
    setGraphPositions([{ id: "a", x: 1, y: 2 }]);
    scheduleGraphLayoutFlush();
    await flushGraphLayoutNow();
    await vi.advanceTimersByTimeAsync(2000); // debounce must NOT fire again
    const writes = invokeMock.mock.calls.filter(
      (c) => c[0] === "plugin:graph-layout|graph_layout_write",
    );
    expect(writes).toHaveLength(1);
  });

  it("post-lock flush is a no-op (empty-store guard — never re-writes vault A)", async () => {
    invokeMock.mockResolvedValue(undefined);
    setGraphPositions([{ id: "vaultA", x: 1, y: 2 }]);
    resetGraphLayoutOnLock(); // lock drops positions + pending flush
    await flushGraphLayoutNow(); // the unmount cascade after lock
    expect(
      invokeMock.mock.calls.filter(
        (c) => c[0] === "plugin:graph-layout|graph_layout_write",
      ),
    ).toHaveLength(0);
  });
});
