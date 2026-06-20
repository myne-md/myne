// @vitest-environment jsdom
//
// `useSyncStatus` (MYND-424 task 10): the runtime sync-status poller.
// On mount it reads `plugin:sync|sync_status` once, then re-polls on the
// STATUS_POLL_MS cadence, and CLEARS the interval on unmount (the leak
// regression guard). The Tauri `invoke` shim is mocked at the module seam
// (same shape as `tests/notes/loadNoteBatch.test.ts`); fake timers drive the
// poll cadence (same pattern as `tests/notes/useAutosave.test.ts`).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useSyncStatus } from "../../src/hooks/useSyncStatus";

// Mirrors the (unexported) `STATUS_POLL_MS` constant in the hook.
const STATUS_POLL_MS = 5000;

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset().mockResolvedValue({ state: "idle" });
});

afterEach(() => {
  vi.useRealTimers();
  invokeMock.mockReset();
});

describe("useSyncStatus — mount read + mapped status", () => {
  it("invokes the sync_status command once on mount and exposes the status", async () => {
    invokeMock.mockResolvedValueOnce({ state: "idle" });
    const { result } = renderHook(() => useSyncStatus());

    // status is null until the first read resolves.
    expect(result.current.status).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("plugin:sync|sync_status");
    expect(result.current.status).toEqual({ state: "idle" });
  });

  it("maps each source-defined status verbatim", async () => {
    const cases = [
      { state: "disabled" },
      { state: "idle" },
      { state: "syncing" },
      { state: "error", detail: "boom" },
      { state: "conflicts", count: 3 },
    ] as const;

    for (const status of cases) {
      invokeMock.mockReset().mockResolvedValue(status);
      const { result, unmount } = renderHook(() => useSyncStatus());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.status).toEqual(status);
      unmount();
    }
  });
});

describe("useSyncStatus — re-poll cadence", () => {
  it("re-polls on the STATUS_POLL_MS interval (a second invoke fires)", async () => {
    const { result } = renderHook(() => useSyncStatus());

    // First read on mount.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Advancing one poll interval fires a second read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);

    // And a third interval fires a third read — proving it's a repeating
    // interval, not a single setTimeout.
    invokeMock.mockResolvedValue({ state: "syncing" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS);
    });
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(result.current.status).toEqual({ state: "syncing" });
  });
});

describe("useSyncStatus — interval cleared on unmount (leak guard)", () => {
  it("does NOT invoke again after unmount, even as timers advance", async () => {
    const { unmount } = renderHook(() => useSyncStatus());

    // First mount read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Unmount must clearInterval — no further reads.
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_POLL_MS * 4);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
