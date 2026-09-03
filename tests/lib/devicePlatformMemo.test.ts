// The desktop half of the `devicePlatform` memo (the mobile twin is
// `mobile/tests/device-platform-memo.test.ts`, and the two exist as a pair
// because the modules are twins).
//
// The value is a compile-time constant of the running binary, so caching it
// removes an IPC round trip per caller. What the cache must NOT do is hold a
// rejection: one transient IPC failure becoming a permanent answer is the
// failure worth a test, and it is invisible from the call site.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../../src/platform/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

let devicePlatform: typeof import("../../src/lib/prefs").devicePlatform;

beforeEach(async () => {
  invoke.mockReset();
  // A fresh module instance per test: the memo is module scope, which is the
  // whole point of it and also the thing that would leak between cases.
  vi.resetModules();
  ({ devicePlatform } = await import("../../src/lib/prefs"));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("devicePlatform memo", () => {
  it("asks the backend once, however many callers ask it", async () => {
    invoke.mockResolvedValue("macos");
    expect(await devicePlatform()).toBe("macos");
    expect(await devicePlatform()).toBe("macos");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    invoke.mockResolvedValue("linux");
    const [a, b] = await Promise.all([devicePlatform(), devicePlatform()]);
    expect([a, b]).toEqual(["linux", "linux"]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a failure, so a transient error is not permanent", async () => {
    invoke.mockRejectedValueOnce(new Error("ipc down")).mockResolvedValue("windows");
    await expect(devicePlatform()).rejects.toThrow("ipc down");
    expect(await devicePlatform()).toBe("windows");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
