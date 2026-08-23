// `devicePlatform` is memoised, and the memo has one rule that matters.
//
// The value is a compile-time constant of the running binary, so caching it
// removes three IPC round trips per process. What the cache must NOT do is hold
// a rejection: two of the four callers read this to decide what a
// secret-handling affordance may claim (`canHoldSecretOnClipboard` gates the
// Copy control on the recovery phrase, `saveSecretToDocuments` picks the
// sentence that tells the user where their phrase went), so one transient IPC
// failure becoming a permanent answer is the failure worth a test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../src/platform/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

let devicePlatform: typeof import("../src/lib/prefs").devicePlatform;

beforeEach(async () => {
  invoke.mockReset();
  // A fresh module instance per test: the memo is module scope, which is the
  // whole point of it and also the thing that would leak between cases.
  vi.resetModules();
  ({ devicePlatform } = await import("../src/lib/prefs"));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("devicePlatform memo", () => {
  it("asks the backend once, however many callers ask it", async () => {
    invoke.mockResolvedValue("ios");
    expect(await devicePlatform()).toBe("ios");
    expect(await devicePlatform()).toBe("ios");
    expect(await devicePlatform()).toBe("ios");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    invoke.mockResolvedValue("android");
    const [a, b] = await Promise.all([devicePlatform(), devicePlatform()]);
    expect([a, b]).toEqual(["android", "android"]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a failure, so a transient error is not permanent", async () => {
    // The direction that matters. A cached rejected promise would leave every
    // later caller reading a failure that has long since stopped happening, and
    // the callers that read this decide what the app may claim about a file
    // holding a plaintext recovery phrase.
    invoke.mockRejectedValueOnce(new Error("ipc down")).mockResolvedValue("ios");
    await expect(devicePlatform()).rejects.toThrow("ipc down");
    expect(await devicePlatform()).toBe("ios");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
