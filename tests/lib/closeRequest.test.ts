// @vitest-environment jsdom
//
// The app's single close path (myne-md/myne#945 item 05).
//
// What is pinned here is the property the bug violated: a close request ALWAYS
// ends in one of exactly two states: the window is destroyed, or a guard
// explicitly refused, and no other state can persist. The failure this file
// exists for was a third state ("nothing happens, the window ignores the close
// button"), reached by a listener that belonged to a screen that had unmounted.
// So the cases below are mostly about the ways a guard can misbehave: refusing,
// throwing, hanging, overstaying its registration.
//
// Tauri's half is not testable from here and is not the point: `prevent_close()`
// on any existing listener is upstream behaviour (manager/window.rs), verified in
// the issue. What this file owns is that the listener WE install always finishes
// what it started.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CloseEvent = { preventDefault: () => void };

const handlers: Array<(e: CloseEvent) => void | Promise<void>> = [];
const destroy = vi.fn(async () => {});
const onCloseRequested = vi.fn(async (cb: (e: CloseEvent) => void | Promise<void>) => {
  handlers.push(cb);
  return () => {
    const i = handlers.indexOf(cb);
    if (i >= 0) handlers.splice(i, 1);
  };
});

/** A handle the host hands back instead of the real stub, for the one case that
 *  needs a window which lacks the capability at first. `vi.hoisted` because the
 *  mock factory is hoisted above this file's declarations. */
const host = vi.hoisted(() => ({ override: null as null | Record<string, unknown> }));

vi.mock("../../src/platform/webviewWindow", () => ({
  getCurrentWebviewWindow: () => host.override ?? { onCloseRequested, destroy },
}));

/** A fresh module instance per test: it holds process-lifetime state by design. */
async function load() {
  vi.resetModules();
  return import("../../src/lib/close-request");
}

/** Fire the close request the way Tauri would, and await whatever it starts. */
async function requestClose(): Promise<void> {
  expect(handlers).toHaveLength(1);
  const event: CloseEvent = { preventDefault: vi.fn() };
  await handlers[0]!(event);
  expect(event.preventDefault).toHaveBeenCalled();
}

beforeEach(() => {
  handlers.length = 0;
  destroy.mockClear();
  onCloseRequested.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("close-request", () => {
  it("installs ONE listener, however many times it is asked", async () => {
    const m = await load();
    m.installCloseInterceptor();
    m.installCloseInterceptor();
    m.installCloseInterceptor();
    expect(onCloseRequested).toHaveBeenCalledTimes(1);
  });

  it("destroys the window when no screen has anything to flush", async () => {
    // The quick-unlock screen: no guard, and the only quit affordance in the app.
    const m = await load();
    m.installCloseInterceptor();
    await requestClose();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("runs a guard, then destroys", async () => {
    const m = await load();
    m.installCloseInterceptor();
    const flush = vi.fn(async () => true);
    m.registerCloseGuard({ id: "editor", onCloseRequest: flush });
    await requestClose();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("a refusal keeps the window open and stops the chain", async () => {
    const m = await load();
    m.installCloseInterceptor();
    const first = vi.fn(async () => true);
    const second = vi.fn(async () => false);
    m.registerCloseGuard({ id: "first", onCloseRequest: first });
    m.registerCloseGuard({ id: "second", onCloseRequest: second });
    await requestClose();
    // Most recent first, and a refusal is final: the pending user decision it
    // represents cannot be overruled by another screen's flush.
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("unregistering a guard removes it from the path", async () => {
    const m = await load();
    m.installCloseInterceptor();
    const flush = vi.fn(async () => false);
    const unregister = m.registerCloseGuard({ id: "editor", onCloseRequest: flush });
    unregister();
    expect(m.closeGuardIds()).toEqual([]);
    await requestClose();
    expect(flush).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("a stale unregister cannot remove its replacement", async () => {
    // React strict mode mounts twice, and a changed dependency re-registers: the
    // cleanup of the FIRST registration must not delete the second one, or the
    // screen silently stops contributing to the close path.
    const m = await load();
    m.installCloseInterceptor();
    const first = vi.fn(async () => false);
    const second = vi.fn(async () => false);
    const unregisterFirst = m.registerCloseGuard({ id: "editor", onCloseRequest: first });
    m.registerCloseGuard({ id: "editor", onCloseRequest: second });
    unregisterFirst();
    await requestClose();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("a guard that throws cannot veto the close", async () => {
    const m = await load();
    m.installCloseInterceptor();
    m.registerCloseGuard({
      id: "editor",
      onCloseRequest: () => {
        throw new Error("flush exploded");
      },
    });
    await requestClose();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("a guard that never settles is reported, and the close keeps waiting", async () => {
    // The layer below the original bug: a flush that awaits an IPC which never
    // answers (the vault locked underneath it). It must NOT be answered on the
    // guard's behalf, because that is how a note body mid-flush is dropped on the
    // floor (myne-md/myne#945 review, D8): the guards are not all layout, and the
    // first version of this file destroyed the window here.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = await load();
    m.installCloseInterceptor();
    m.registerCloseGuard({ id: "editor", onCloseRequest: () => new Promise<boolean>(() => {}) });
    void requestClose();
    await vi.advanceTimersByTimeAsync(m.CLOSE_GUARD_DEADLINE_MS);
    expect(destroy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("still running"));
    warn.mockRestore();
  });

  it("a second close request forces past a guard that never settles", async () => {
    // The escape hatch that replaced the kill switch: the user asks twice, so the
    // window goes, flush or no flush. Closability is the user's second press
    // rather than a timer's decision.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = await load();
    m.installCloseInterceptor();
    m.registerCloseGuard({ id: "editor", onCloseRequest: () => new Promise<boolean>(() => {}) });
    void requestClose();
    await vi.advanceTimersByTimeAsync(m.CLOSE_GUARD_DEADLINE_MS);
    expect(destroy).not.toHaveBeenCalled();
    await requestClose();
    expect(destroy).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a host that lacks the capability can install once it has one", async () => {
    // `installed` used to stay true on the early return, so ONE close request on
    // a host without `onCloseRequested` disarmed the interceptor for the life of
    // the process and every later attempt was a silent no-op (myne-md/myne#945
    // review, D9).
    const m = await load();
    host.override = {};
    m.installCloseInterceptor();
    expect(onCloseRequested).not.toHaveBeenCalled();
    host.override = null;
    m.installCloseInterceptor();
    expect(onCloseRequested).toHaveBeenCalledTimes(1);
    await requestClose();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a host with no close request to intercept", async () => {
    // The web client: a browser tab's close is the browser's business, and the
    // capacity is absent rather than refused, so this must not throw.
    vi.resetModules();
    vi.doMock("../../src/platform/webviewWindow", () => ({
      getCurrentWebviewWindow: () => ({ listen: async () => () => {} }),
    }));
    const m = await import("../../src/lib/close-request");
    expect(() => m.installCloseInterceptor()).not.toThrow();
    expect(destroy).not.toHaveBeenCalled();
    vi.doUnmock("../../src/platform/webviewWindow");
  });
});
