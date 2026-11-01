// @vitest-environment jsdom
//
// The SYNC-40 compare's poll, tested where it now lives.
//
// These two properties were pinned against `JoinDeviceModal`
// (`tests/sync/join-head-fingerprint-poll.test.tsx`) until the account-number
// join door was removed (`decisions/sync/0767`). The screen is gone; the hook is
// not, and it is the ONE implementation both remaining sides use: the approving
// panel and the joining wait. So the tests move with the subject rather than
// being deleted with the screen.
//
// What they hold:
//
// 1. **The code does not wait for the vault** (#243). The compare needs an
//    adopted head, which is recorded before note bodies download; `sync_now`
//    claims the approval AND pulls the whole vault. Awaiting it gated the code
//    behind the entire download, a multi-minute "waiting for approval" on a
//    small vault, and on a large one a tick that never returns and a screen that
//    never advances. MYND-537 fixed this on mobile; this is the desktop end.
// 2. **At most one `sync_now` in flight.** Two overlapping full syncs contend
//    for the same vault, so the cycle is fired and watched, never awaited, and
//    never re-fired while the previous one is still running.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useHeadFingerprintCompare } from "../../src/hooks/useHeadFingerprintCompare";

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useHeadFingerprintCompare: the joiner's poll", () => {
  it("shows the code while sync_now is still running", async () => {
    vi.useFakeTimers();
    let syncNowStarted = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:sync|sync_now") {
        syncNowStarted += 1;
        // A first sync on a large vault: it does not come back.
        return new Promise(() => {});
      }
      if (cmd === "plugin:sync|sync_head_fingerprint") return Promise.resolve("K3M9-QR7T");
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useHeadFingerprintCompare(true, "joiner"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(syncNowStarted).toBe(1);
    expect(result.current.fingerprint, "the code is on screen before the vault arrives").toBe(
      "K3M9-QR7T",
    );
  });

  it("keeps at most one sync_now in flight across ticks", async () => {
    vi.useFakeTimers();
    let syncNowStarted = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:sync|sync_now") {
        syncNowStarted += 1;
        return new Promise(() => {});
      }
      // Still pending approval: no head adopted yet.
      if (cmd === "plugin:sync|sync_head_fingerprint") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useHeadFingerprintCompare(true, "joiner"));

    // Five ~1 s ticks of the fingerprint poll…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_200);
    });

    // …and still exactly one full sync: overlapping ones would contend for the
    // same vault.
    expect(syncNowStarted).toBe(1);
    expect(result.current.fingerprint).toBeNull();
  });

  it("releases the push hold when the screen goes away", async () => {
    vi.useFakeTimers();
    const commands: string[] = [];
    invokeMock.mockImplementation((cmd: string) => {
      commands.push(cmd);
      if (cmd === "plugin:sync|sync_head_fingerprint") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });

    const { unmount } = renderHook(() => useHeadFingerprintCompare(true, "joiner"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(commands).toContain("plugin:sync|sync_verify_hold_begin");

    unmount();
    // The lease would drop it within 15 s anyway, but holding a device's pushes
    // for 15 s after the user closed the screen is pure cost.
    expect(commands).toContain("plugin:sync|sync_verify_hold_end");
  });
});
