// @vitest-environment jsdom
//
// The unsynced-edit marker's data source (phase3-web-client task 23).
//
// The properties under test are the three the task names, and each of them is a
// property about what the marker must NOT do:
//
//   1. it is visible without asking — so the hook polls rather than waiting for
//      a user gesture;
//   2. it clears only on a server acknowledgement — so nothing local, including
//      a failed poll, may clear it;
//   3. it survives a reload — so the answer is recomputed from disk each time
//      rather than accumulated in RAM.
//
// (3) is a property of the COMMAND (`sync_unsynced_edits` derives everything
// from each note's `MY01` nonce and the `sync-state.json` baselines; the Rust
// side pins it). What this file can pin is the hook's half: a remount must ask
// again and take whatever disk says, with no memory of the previous session —
// which is what makes the command's statelessness reach the UI.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const invoke = vi.fn();
const listeners = new Map<string, () => void>();

vi.mock("../../src/platform/core", () => ({
  invoke: (cmd: string) => invoke(cmd),
}));
vi.mock("../../src/platform/event", () => ({
  listen: async (ev: string, cb: () => void) => {
    listeners.set(ev, cb);
    return () => listeners.delete(ev);
  },
}));

async function mount() {
  const { useUnsyncedEdits } = await import("../../src/hooks/useUnsyncedEdits");
  return renderHook(() => useUnsyncedEdits());
}

beforeEach(() => {
  invoke.mockReset();
  listeners.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useUnsyncedEdits", () => {
  it("asks on mount, with no gesture — the marker is not something you open a panel to see", async () => {
    invoke.mockResolvedValue({ note_ids: ["a", "b"], tracking: true });
    const { result } = await mount();
    await waitFor(() => expect(result.current.unsyncedIds.size).toBe(2));
    expect(invoke).toHaveBeenCalledWith("plugin:sync|sync_unsynced_edits");
    expect(result.current.unsyncedIds.has("a")).toBe(true);
    expect(result.current.tracking).toBe(true);
  });

  it("clears a note only when the command stops naming it", async () => {
    invoke.mockResolvedValue({ note_ids: ["a"], tracking: true });
    const { result } = await mount();
    await waitFor(() => expect(result.current.unsyncedIds.has("a")).toBe(true));

    // The command is the only authority. It reports "a" as acknowledged; the
    // hook follows. (What makes the command's answer trustworthy — that only a
    // push response advances the baseline — is pinned in Rust.)
    invoke.mockResolvedValue({ note_ids: [], tracking: true });
    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.unsyncedIds.size).toBe(0));
  });

  it("keeps the last answer when a poll FAILS, rather than reporting all-clear", async () => {
    // The failure mode this guards against is the quiet one: a transient IPC
    // failure is not evidence that an edit reached the server, and a hook that
    // reset to empty on error would tell the user their unsynced note is safe
    // at exactly the moment the client stopped being able to find out.
    invoke.mockResolvedValue({ note_ids: ["a"], tracking: true });
    const { result } = await mount();
    await waitFor(() => expect(result.current.unsyncedIds.has("a")).toBe(true));

    invoke.mockRejectedValue(new Error("worker gone"));
    await act(async () => {
      result.current.refresh();
      await Promise.resolve();
    });
    expect(result.current.unsyncedIds.has("a")).toBe(true);
  });

  it("re-reads on the engine's status nudge, not only on the poll interval", async () => {
    // A completed cycle is exactly when the answer changes. Waiting a whole
    // interval would leave the marker lit on a note that is already safe.
    invoke.mockResolvedValue({ note_ids: ["a"], tracking: true });
    const { result } = await mount();
    await waitFor(() => expect(result.current.unsyncedIds.has("a")).toBe(true));

    invoke.mockResolvedValue({ note_ids: [], tracking: true });
    await act(async () => {
      listeners.get("sync://status-changed")?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.unsyncedIds.size).toBe(0));
  });

  it("remembers nothing across a remount — the answer comes from disk, so a reload re-derives it", async () => {
    invoke.mockResolvedValue({ note_ids: ["a", "b"], tracking: true });
    const first = await mount();
    await waitFor(() => expect(first.result.current.unsyncedIds.size).toBe(2));
    first.unmount();

    // Same "session", different answer on disk: one of the two was pushed while
    // the component was unmounted. A hook carrying state across the remount
    // would show the stale pair.
    invoke.mockResolvedValue({ note_ids: ["b"], tracking: true });
    const second = await mount();
    await waitFor(() => expect(second.result.current.unsyncedIds.size).toBe(1));
    expect(second.result.current.unsyncedIds.has("b")).toBe(true);
  });

  it("distinguishes 'nothing pending' from 'no sync promise at all'", async () => {
    // Both are an empty list, and only one of them is an assurance. A caller
    // that reads the empty list alone cannot tell a fully-synced vault from a
    // desktop that never configured an endpoint — hence the flag.
    invoke.mockResolvedValue({ note_ids: [], tracking: false });
    const { result } = await mount();
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(result.current.unsyncedIds.size).toBe(0);
    expect(result.current.tracking).toBe(false);
  });
});
