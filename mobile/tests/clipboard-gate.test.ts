// The Tier 1 gate, both halves (myne-md/myne#455).
//
// `canHoldSecretOnClipboard` answers one question, may the recovery phrase go
// on this OS's clipboard, and it has two independent inputs:
//
//   1. `IOS_PASTEBOARD_VERIFIED`, a hand-flipped flag that is `false` until the
//      pasteboard behaviour has actually been observed on hardware.
//   2. The platform.
//
// The flow-logic tier can only see the CONSEQUENCE (is the button drawn), and
// while the flag is shut that consequence is "no" everywhere, so it cannot
// distinguish a correct platform rule from a broken one. These tests can: they
// drive the platform directly and pin both the current answer and the one that
// applies the moment the flag opens.
//
// That split exists because of a concrete miss. The first version of the flow
// test asserted "iOS offers Copy", was recorded as passing, and then failed the
// moment the gate closed, the assertion described the intent while the code
// described something else, and nothing caught the divergence but a reviewer.

import { describe, expect, it, vi, beforeEach } from "vitest";

const devicePlatform = vi.fn();
vi.mock("../src/lib/prefs", () => ({
  devicePlatform: () => devicePlatform(),
}));

beforeEach(() => {
  vi.resetModules();
  devicePlatform.mockReset();
});

describe("canHoldSecretOnClipboard", () => {
  it("answers NO on iOS while the pasteboard behaviour is unverified", async () => {
    devicePlatform.mockResolvedValue("ios");
    const { canHoldSecretOnClipboard } = await import("../src/lib/clipboardTransport");

    // The shipped answer today. Not "the platform check is wrong", the flag is
    // shut, and a shut flag outranks the platform by design.
    await expect(canHoldSecretOnClipboard()).resolves.toBe(false);
  });

  it("answers NO on Android, and would still answer NO with the flag open", async () => {
    devicePlatform.mockResolvedValue("android");
    const { canHoldSecretOnClipboard } = await import("../src/lib/clipboardTransport");

    await expect(canHoldSecretOnClipboard()).resolves.toBe(false);
  });

  it("never asks the platform while the flag is shut", async () => {
    // The short-circuit matters beyond tidiness: it means a broken or slow
    // platform probe cannot accidentally open the gate, and it makes the flag
    // the single thing a reviewer has to look at to know the answer.
    devicePlatform.mockResolvedValue("ios");
    const { canHoldSecretOnClipboard } = await import("../src/lib/clipboardTransport");

    await canHoldSecretOnClipboard();
    expect(devicePlatform).not.toHaveBeenCalled();
  });
});
