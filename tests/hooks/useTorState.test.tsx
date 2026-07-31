// @vitest-environment jsdom
//
// `useTorState` (MYND-650 task 8): the shared Tor-posture poller.
//
// Three properties are worth pinning, and none of them is "does it read once".
//
// 1. **One poll, one answer.** The banner and the Network panel are mounted at
//    the same time and are two views of one fact. Independent polls would show
//    two different postures for up to a tick — including the tick right after
//    the user flips the toggle, which is the moment they are watching.
// 2. **A dropped read is not a fail-closed state.** Flipping to "unavailable"
//    on an IPC hiccup would raise a security warning over nothing, which is how
//    a warning that means something becomes one users dismiss.
// 3. **Unmount stops the timer** and forgets the value, so the next mount
//    re-reads instead of rendering a posture that aged with nobody watching.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const { useTorState } = await import("../../src/hooks/useTorState");

/** Mirrors the (unexported) `ACTIVE_POLL_MS`. */
const ACTIVE_POLL_MS = 2000;

/** Let the mocked promise settle inside `act`, with fake timers running. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset().mockResolvedValue({ enabled: true, state: { kind: "starting" } });
});

afterEach(() => {
  // Unmount every hook this file rendered BEFORE the timers go back to real:
  // the store is module-level, so a subscriber left behind by a failing
  // assertion would silently suppress the next test's mount-read and turn one
  // failure into five.
  cleanup();
  vi.useRealTimers();
  invokeMock.mockReset();
});

describe("useTorState", () => {
  it("reads once on mount and exposes the derived posture", async () => {
    const { result, unmount } = renderHook(() => useTorState());
    expect(result.current.posture).toBeNull();

    await settle();
    expect(invokeMock).toHaveBeenCalledWith("plugin:sync|sync_get_tor_state");
    expect(result.current.posture).toBe("connecting");
    unmount();
  });

  it("serves every subscriber from one poll", async () => {
    const first = renderHook(() => useTorState());
    const second = renderHook(() => useTorState());
    await settle();

    // Two mounted consumers, one IPC — and they agree.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(first.result.current.posture).toBe("connecting");
    expect(second.result.current.posture).toBe("connecting");

    invokeMock.mockResolvedValue({ enabled: true, state: { kind: "ready" } });
    await act(async () => {
      vi.advanceTimersByTime(ACTIVE_POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(first.result.current.posture).toBe("active");
    expect(second.result.current.posture).toBe("active");

    first.unmount();
    second.unmount();
  });

  it("keeps the last posture when a read fails, rather than claiming the tunnel is down", async () => {
    invokeMock.mockResolvedValueOnce({ enabled: true, state: { kind: "ready" } });
    const { result, unmount } = renderHook(() => useTorState());
    await settle();
    expect(result.current.posture).toBe("active");

    invokeMock.mockRejectedValueOnce(new Error("ipc hiccup"));
    await act(async () => {
      vi.advanceTimersByTime(ACTIVE_POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.posture).toBe("active");
    unmount();
  });

  it("stops polling on unmount and re-reads on the next mount", async () => {
    const { unmount } = renderHook(() => useTorState());
    await settle();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(ACTIVE_POLL_MS * 5);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    const remounted = renderHook(() => useTorState());
    // Nothing was watching, so nothing is remembered: `null` until the fresh
    // read lands.
    expect(remounted.result.current.posture).toBeNull();
    await settle();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    remounted.unmount();
  });

  it("refresh() re-reads without waiting for the tick", async () => {
    const { result, unmount } = renderHook(() => useTorState());
    await settle();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    invokeMock.mockResolvedValue({ enabled: false, state: { kind: "stopped" } });
    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result.current.posture).toBe("inactive");
    unmount();
  });
});
