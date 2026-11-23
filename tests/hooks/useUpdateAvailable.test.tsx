// @vitest-environment jsdom
//
// The install flow's ORDER, which is the load-bearing part of
// `src/hooks/useUpdateAvailable.ts` (myne-md/myne#870).
//
// Four steps run on a confirmed update and only one order is correct: flush the
// open panes, lock the vault, enter the updating stage, install. The flush is the
// only step that needs the keys, and the stage is what unmounts the panes the
// flush writes through, so a reorder is silent in every other test in this tree:
// it typechecks, the happy path still "works", and the failure it causes is a
// note whose last keystrokes were lost.
//
// The lock-failure arm is here for the same reason. It must NOT install (the
// confirmation promised a locked vault) and it must NOT stay in the confirm (the
// user would believe nothing happened).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

// `vi.hoisted` because the mock factories below are hoisted above every top
// level `const`: without it the factories close over bindings that do not exist
// yet and vitest refuses the module.
const h = vi.hoisted(() => {
  const state = {
    /** Every side effect, in the order it was reached. */
    calls: [] as string[],
    installShouldReject: false,
    lockShouldReject: false,
    flushShouldReject: false,
    /** True when the caller must refuse the stage transition. */
    stageShouldRefuse: false,
    /** The event name the hook subscribes on; asserted, not just passed through. */
    progressEvent: "update:progress",
    /** The handler `listen` was handed, so a test can drive a tick into it. */
    progressHandler: null as null | ((event: { payload: unknown }) => void),
    unlisten: vi.fn(),
  };
  return {
    state,
    flushOpenPanes: vi.fn(() => {
      state.calls.push("flush");
      return state.flushShouldReject
        ? Promise.reject(new Error("no"))
        : Promise.resolve();
    }),
    lockVault: vi.fn(() => {
      state.calls.push("lock");
      return state.lockShouldReject
        ? Promise.reject(new Error("no"))
        : Promise.resolve();
    }),
    updateInstall: vi.fn(() => {
      state.calls.push("install");
      return state.installShouldReject
        ? Promise.reject(new Error("no"))
        : Promise.resolve();
    }),
    updateCheck: vi.fn(() => {
      state.calls.push("check");
      return Promise.resolve({
        kind: "available" as const,
        version: "0.10.1",
        notes: "Fixes a crash on launch.",
      });
    }),
    getAutoCheck: vi.fn(() => Promise.resolve(true)),
  };
});

vi.mock("../../src/platform/capabilities", () => ({ has: () => true }));
vi.mock("../../src/platform/update", () => ({
  getAutoCheck: h.getAutoCheck,
  updateCheck: h.updateCheck,
  updateInstall: h.updateInstall,
  UPDATE_PROGRESS_EVENT: h.state.progressEvent,
}));
vi.mock("../../src/platform/event", () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) => {
    if (name !== h.state.progressEvent) return Promise.reject(new Error(name));
    h.state.progressHandler = handler;
    return Promise.resolve(h.state.unlisten);
  },
}));
vi.mock("../../src/lib/vault-unlock", () => ({ lockVault: h.lockVault }));
vi.mock("../../src/notes/renameFlushHook", () => ({
  renameFlushHooks: () => ({ flushOpenPanes: h.flushOpenPanes }),
}));

import { useUpdateAvailable } from "../../src/hooks/useUpdateAvailable";

beforeEach(() => {
  vi.useFakeTimers();
  h.state.calls = [];
  h.state.installShouldReject = false;
  h.state.lockShouldReject = false;
  // Every arm reset, not just the ones an earlier test happened to set: the
  // flush arm leaked into the two tests after it when this line was missing.
  h.state.flushShouldReject = false;
  h.state.stageShouldRefuse = false;
  h.state.progressHandler = null;
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Mount the hook and let the automatic check fire. */
async function mountChecked(options: { enabled?: boolean } = {}) {
  const onLocked = vi.fn(() => {
    h.state.calls.push("stage");
    // The caller reports whether the app actually moved into the updating stage.
    return !h.state.stageShouldRefuse;
  });
  const enabled = options.enabled ?? true;
  const hook = renderHook(
    ({ on }: { on: boolean }) =>
      useUpdateAvailable({ enabled: on, onLocked }),
    { initialProps: { on: enabled } },
  );
  if (enabled) {
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    // A second drain for the promise chain the timer started: `act` flushes the
    // microtask queue, and the check is three hops deep.
    await act(async () => {});
  }
  return { hook, onLocked };
}

/**
 * Promote every pending microtask. `waitFor` is unusable in this file: it polls
 * on real timers, and this suite runs on fake ones, so the two deadlock until the
 * five-second timeout. Several turns, because a confirm is a chain of awaits
 * (flush, then lock, then the install's own catch) and one turn only reaches the
 * first link.
 */
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {});
  }
}

describe("the automatic check", () => {
  it("offers what the host reported, and does not check at all while disabled", async () => {
    const { hook } = await mountChecked({ enabled: false });
    expect(hook.result.current.view).toBeNull();
    expect(h.getAutoCheck).not.toHaveBeenCalled();

    hook.rerender({ on: true });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await settle();
    expect(hook.result.current.view).toBe("offer");
    expect(hook.result.current.version).toBe("0.10.1");
    expect(hook.result.current.notes).toBe("Fixes a crash on launch.");
  });

  it("reduces the offer to the pill after a moment, but never a confirm the user opened", async () => {
    const { hook } = await mountChecked();
    expect(hook.result.current.view).toBe("offer");

    act(() => vi.advanceTimersByTime(8_000));
    expect(hook.result.current.view).toBe("pill");

    // Reopened, then expanded into the confirm: a decision in progress is not
    // something the collapse timer may take away mid-read.
    act(() => hook.result.current.reopen());
    act(() => hook.result.current.request());
    expect(hook.result.current.view).toBe("confirm");
    act(() => vi.advanceTimersByTime(60_000));
    expect(hook.result.current.view).toBe("confirm");

    act(() => hook.result.current.cancel());
    expect(hook.result.current.view).toBe("offer");
  });

  it("keeps a dismissed offer dismissed for the session", async () => {
    const { hook } = await mountChecked();
    act(() => hook.result.current.later());
    expect(hook.result.current.view).toBeNull();

    // The daily re-check must not resurrect it, which a second `view` write from
    // the check would do.
    await act(async () => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    });
    await settle();
    expect(hook.result.current.view).toBeNull();
  });
});

describe("the install's progress stream", () => {
  it("subscribes once, on the event name the host emits", async () => {
    await mountChecked();
    await settle();
    // A name that drifted from `PROGRESS_EVENT` in Rust is a bar that never
    // moves and says nothing about why, so the constant is asserted rather than
    // trusted. The ORIGINAL module is imported, not the mock's own initialiser:
    // `expect(mock.progressEvent).toBe("update:progress")` compared the mock to
    // itself and stayed green when the real constant was changed to
    // "update:progress-DRIFT" (measured, myne-md/myne#1022 review).
    const real =
      await vi.importActual<typeof import("../../src/platform/update")>(
        "../../src/platform/update",
      );
    expect(real.UPDATE_PROGRESS_EVENT).toBe("update:progress");
    expect(h.state.progressEvent).toBe(real.UPDATE_PROGRESS_EVENT);
    expect(h.state.progressHandler).not.toBeNull();
  });

  it("reports the host's ticks, and keeps the byte counts through the later phases", async () => {
    const { hook } = await mountChecked();
    await settle();
    expect(hook.result.current.progress.phase).toBe("starting");

    act(() => {
      h.state.progressHandler?.({
        payload: { phase: "downloading", downloaded: 2048, total: 8192 },
      });
    });
    expect(hook.result.current.progress).toEqual({
      phase: "downloading",
      downloaded: 2048,
      total: 8192,
    });

    act(() => {
      h.state.progressHandler?.({ payload: { phase: "verifying" } });
    });
    // The phase moves; the numbers stay, because the screen shows a full bar for
    // these phases and a retry starts from what the host last reported.
    expect(hook.result.current.progress).toEqual({
      phase: "verifying",
      downloaded: 2048,
      total: 8192,
    });
  });

  it("never reports a byte count below the one it already showed", async () => {
    // myne-md/myne#1059: two installs on one event name made the bar and the
    // readout run backwards ("190mb -> 178mb -> 200mb"). The host refuses a
    // second install now, and this is the other half: the display cannot regress
    // even if something else ever emits on this name.
    const { hook } = await mountChecked();
    await settle();
    const tick = (downloaded: number, total: number | null = 8192) =>
      act(() => {
        h.state.progressHandler?.({
          payload: { phase: "downloading", downloaded, total },
        });
      });

    tick(5000);
    tick(3000); // a lower number arrives out of order
    expect(hook.result.current.progress.downloaded).toBe(5000);

    tick(6000);
    expect(hook.result.current.progress.downloaded).toBe(6000);

    // A tick that carries no total does not erase the one already measured,
    // because the bar would then fall back to indeterminate mid-download.
    tick(7000, null);
    expect(hook.result.current.progress.total).toBe(8192);
    expect(hook.result.current.progress.downloaded).toBe(7000);
  });

  it("resets to the starting shape when a retry begins a new attempt", async () => {
    h.state.installShouldReject = true;
    const { hook } = await mountChecked();
    await act(async () => {
      hook.result.current.confirm();
    });
    await settle();
    act(() => {
      h.state.progressHandler?.({
        payload: { phase: "downloading", downloaded: 4096, total: 8192 },
      });
    });
    expect(hook.result.current.progress.phase).toBe("downloading");

    h.state.installShouldReject = false;
    await act(async () => {
      hook.result.current.retry();
    });
    await settle();
    // A retry downloads the whole artifact again, so a bar left at the previous
    // attempt's byte count would claim progress that was thrown away.
    expect(hook.result.current.progress).toEqual({
      phase: "starting",
      downloaded: 0,
      total: null,
    });
  });

  it("unsubscribes on unmount", async () => {
    const { hook } = await mountChecked();
    await settle();
    hook.unmount();
    await settle();
    expect(h.state.unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("the confirmed install", () => {
  it("flushes, locks, enters the stage and installs, in that order", async () => {
    const { hook, onLocked } = await mountChecked();
    // Drop the check's own entry: this test is about the flow's order, and the
    // check legitimately happens before it.
    h.state.calls = [];
    await act(async () => {
      hook.result.current.confirm();
    });
    await settle();

    // The stage callback appends "stage" itself, so this one assertion is the
    // whole order rather than four separate ones that could each pass alone.
    expect(h.state.calls).toEqual(["flush", "lock", "stage", "install"]);
    expect(onLocked).toHaveBeenCalledTimes(1);
    expect(hook.result.current.phase).toBe("working");
  });

  it("does not install when the vault cannot be locked, and reports which step refused", async () => {
    h.state.lockShouldReject = true;
    const { hook, onLocked } = await mountChecked();
    h.state.calls = [];
    await act(async () => {
      hook.result.current.confirm();
    });
    await settle();

    expect(h.updateInstall).not.toHaveBeenCalled();
    expect(onLocked).not.toHaveBeenCalled();
    expect(h.state.calls).toEqual(["flush", "lock"]);
    // The stage never moved, so the notice is still on screen and it is the
    // surface that has to carry the refusal. `phase` stays idle because the
    // updating screen is unreachable without a lock.
    expect(hook.result.current.blocked).toBe("lock");
    expect(hook.result.current.phase).toBe("idle");
  });

  it("stops before the lock when a pane would not save, because the lock destroys the buffer", async () => {
    h.state.flushShouldReject = true;
    const { hook, onLocked } = await mountChecked();
    h.state.calls = [];
    await act(async () => {
      hook.result.current.confirm();
    });
    await settle();

    // The order is the whole point of this arm: locking after a rejected flush
    // unmounts the panes holding the edits that did not reach disk.
    expect(h.state.calls).toEqual(["flush"]);
    expect(h.lockVault).not.toHaveBeenCalled();
    expect(h.updateInstall).not.toHaveBeenCalled();
    expect(onLocked).not.toHaveBeenCalled();
    expect(hook.result.current.blocked).toBe("flush");
    expect(hook.result.current.phase).toBe("idle");
  });

  it("does not install when the app has already left the editor stage", async () => {
    h.state.stageShouldRefuse = true;
    const { hook } = await mountChecked();
    h.state.calls = [];
    await act(async () => {
      hook.result.current.confirm();
    });
    await settle();

    // The refused transition means there is no updating screen to report a
    // failure on, so the install must not start at all.
    expect(h.state.calls).toEqual(["flush", "lock", "stage"]);
    expect(h.updateInstall).not.toHaveBeenCalled();
    expect(hook.result.current.blocked).toBe("stage");
    expect(hook.result.current.phase).toBe("idle");
  });

  it("ignores a second press while the first is still in flight", async () => {
    const { hook } = await mountChecked();
    h.state.calls = [];
    await act(async () => {
      hook.result.current.confirm();
      hook.result.current.confirm();
    });
    await settle();

    // Two chains would run two installers against one bundle, which is worse
    // than a failed install.
    expect(h.state.calls).toEqual(["flush", "lock", "stage", "install"]);
  });

  it("reaches the failed phase when the install fails, and retries without re-locking", async () => {
    h.state.installShouldReject = true;
    const { hook, onLocked } = await mountChecked();
    h.state.calls = [];
    await act(async () => {
      hook.result.current.confirm();
    });
    await settle();
    expect(hook.result.current.phase).toBe("failed");

    h.state.installShouldReject = false;
    h.state.calls = [];
    await act(async () => {
      hook.result.current.retry();
    });
    await settle();

    // The retry must not flush or lock again: the panes are gone and the vault
    // is already locked by this point.
    expect(h.state.calls).toEqual(["install"]);
    expect(hook.result.current.phase).toBe("working");
    expect(onLocked).toHaveBeenCalledTimes(1);
  });
});
