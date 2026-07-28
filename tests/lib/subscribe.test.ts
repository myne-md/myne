// A failed event subscription must not become an unhandled rejection.
//
// This is a property no type checker sees and no desktop run reaches: `listen`
// resolves before any React tree mounts on desktop, so the rejected branch is
// dead code there. It is live in the web client, where `listen` is a Worker
// message subscription that can fail — and where an unhandled rejection is
// escalated into the fatal screen by `global-failure.ts`. A status indicator
// that could not subscribe would have taken the app down.
//
// The disposal race matters for the same reason it was hand-written at every
// original call site: React effects unmount before an in-flight promise settles,
// and a handle that arrives after disposal is a subscription nothing will ever
// release.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listenMock = vi.fn();
vi.mock("../../src/platform/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import { subscribeToEvents } from "../../src/lib/subscribe";

describe("subscribeToEvents", () => {
  beforeEach(() => {
    listenMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles a rejected subscription instead of leaking it", async () => {
    // The assertion is the absence of an unhandled rejection, which vitest
    // reports as a suite-level error rather than a test failure — so the test
    // also pins the observable consequence (a warning naming the event) to make
    // a regression legible rather than mysterious.
    listenMock.mockRejectedValue(new Error("worker is not up"));
    const dispose = subscribeToEvents(["sync://status-changed"], () => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("sync://status-changed"),
      expect.any(Error),
    );
    dispose();
  });

  it("keeps the other subscriptions when one of them fails", () => {
    // Partial failure is the realistic shape — one event name unrecognised by a
    // worker that is otherwise fine. Losing the healthy subscriptions too would
    // turn a small degradation into a total one.
    listenMock.mockImplementation((event: string) =>
      event === "bad" ? Promise.reject(new Error("no")) : Promise.resolve(() => {}),
    );
    const dispose = subscribeToEvents(["bad", "good"], () => {});
    expect(listenMock).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("releases a handle that arrives after disposal", async () => {
    // The race every hand-written copy was guarding: the effect cleanup runs
    // before `listen` settles, so the handle has to be unlistened on arrival or
    // it is retained forever.
    const unlisten = vi.fn();
    let settle: (fn: () => void) => void = () => {};
    listenMock.mockReturnValue(
      new Promise<() => void>((resolve) => {
        settle = resolve;
      }),
    );
    const dispose = subscribeToEvents(["sync://changed"], () => {});
    dispose();
    settle(unlisten);
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unlistens each settled subscription exactly once", async () => {
    const a = vi.fn();
    const b = vi.fn();
    listenMock
      .mockResolvedValueOnce(a as unknown as () => void)
      .mockResolvedValueOnce(b as unknown as () => void);
    const dispose = subscribeToEvents(["one", "two"], () => {});
    await Promise.resolve();
    await Promise.resolve();
    dispose();
    // Called a second time because a React StrictMode double-invoke or a defensive
    // caller can do exactly that; the second call must be a no-op rather than a
    // double-unlisten on a handle the backend already released.
    dispose();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
