// The MYI1 lock seam, both directions (`protocol.md` §9.8.5).
//
// "Manual lock/quit MAY flush it to `vault.indices` first (persist-then-wipe);
// idle auto-lock skips the flush (fail-closed) and the next unlock rebuilds the
// missing delta." `lockVault` is mobile's single lock choke point, so the gate
// lives there and this is where it is pinned: deleting it, or inverting it, is
// otherwise invisible to every suite (the flow tier and Vitest both stayed
// green on an inverted gate before this spec existed).
//
// The ordering half matters too: the flush is a WRITE that needs the slot, so
// it has to run before the lock IPC, not after it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flushIndices: vi.fn(async () => {}),
  resetIndices: vi.fn(),
  invoke: vi.fn(async () => undefined),
}));

vi.mock("../src/platform/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...(args as [])),
}));
vi.mock("../src/lib/vault-indices-lifecycle", () => ({
  flushVaultIndicesPersistNow: () => mocks.flushIndices(),
  resetVaultIndicesLifecycle: () => mocks.resetIndices(),
}));
vi.mock("../src/lib/graph-layout-persist", () => ({
  flushGraphLayoutNow: vi.fn(async () => {}),
  resetGraphLayoutOnLock: vi.fn(),
}));
vi.mock("../src/lib/workspace-persist", () => ({
  flushWorkspaceNow: vi.fn(async () => {}),
  resetWorkspaceOnLock: vi.fn(),
}));
vi.mock("../src/lib/agent-lifetime", () => ({ endAgentRun: vi.fn() }));
vi.mock("../src/lib/chatHistory", () => ({ clearChatHistoryPersistForLock: vi.fn() }));
vi.mock("../src/lib/customTheme", () => ({ clearCustomTheme: vi.fn() }));
vi.mock("@myne/editor/attachments/decoded-aspect", () => ({ resetDecodedAspects: vi.fn() }));
vi.mock("@myne/editor/attachments/session-caches", () => ({
  resetMermaidZoom: vi.fn(),
  resetPreviewCache: vi.fn(),
  resetTranscripts: vi.fn(),
}));
vi.mock("@myne/editor/host/lib/datetimeFormat", () => ({
  resetDateTimeDisplayForLock: vi.fn(),
}));

import { lockVault } from "../src/lib/vault-unlock";

beforeEach(() => {
  mocks.flushIndices.mockClear();
  mocks.resetIndices.mockClear();
  mocks.invoke.mockClear();
});

describe("lockVault and the MYI1 flush", () => {
  it("flushes on a manual lock, before the lock IPC", async () => {
    await lockVault("manual");
    expect(mocks.flushIndices).toHaveBeenCalledTimes(1);
    const flushOrder = mocks.flushIndices.mock.invocationCallOrder[0];
    const lockCall = mocks.invoke.mock.calls.findIndex(
      (call) => call[0] === "plugin:vault-unlock|lock",
    );
    expect(lockCall).toBeGreaterThanOrEqual(0);
    expect(flushOrder).toBeLessThan(mocks.invoke.mock.invocationCallOrder[lockCall]);
    expect(mocks.resetIndices).toHaveBeenCalledTimes(1);
  });

  it("treats a param-less lock as manual (an unclassified caller flushes)", async () => {
    await lockVault();
    expect(mocks.flushIndices).toHaveBeenCalledTimes(1);
  });

  it("flushes on a vault switch, which drops the keys immediately after", async () => {
    await lockVault("switch");
    expect(mocks.flushIndices).toHaveBeenCalledTimes(1);
  });

  it("skips the flush on idle auto-lock and still resets the lifecycle", async () => {
    await lockVault("idle");
    // Fail-closed: the A6 key drop must not sit behind an AEAD encode of a
    // large index, and the next unlock rebuilds the missing delta.
    expect(mocks.flushIndices).not.toHaveBeenCalled();
    // The latch and the dirty flag are per unlock session either way.
    expect(mocks.resetIndices).toHaveBeenCalledTimes(1);
    expect(
      mocks.invoke.mock.calls.some((call) => call[0] === "plugin:vault-unlock|lock"),
    ).toBe(true);
  });
});
