// myne-md/myne#535: a teardown step that throws must not prevent the lock.
//
// `lockVault()` runs five plaintext-teardown resets and THEN invokes
// `plugin:vault-unlock|lock`. The ordering is deliberate (a vault switch must
// not carry one vault's graph positions into another's encrypted cache), and it
// quietly turned "before" into "instead of": a throw from any reset rejected
// `lockVault()` before the IPC was ever issued.
//
// What that cost is not a lost cache. Both callers swallow the rejection and
// route on regardless (`Editor.tsx`'s `handleLockFlushed`, `vault-switch.ts`'s
// `leaveActiveVault`), so the user was shown the lock screen while the slot
// still held `root_key` and the plaintext-derived state the failed step was
// meant to wipe was still resident. `threat-model.md` §1 A6 rates the
// stolen-unlocked-device case mitigated on auto-lock deterministically
// zeroizing the in-memory keys, and on the web client the Editor's own idle
// hook is what drives that, so the unmount that follows removed the only thing
// that would have tried again.
//
// This is the same rule `runFlushChain` already states one layer up ("the chain
// is best-effort and CANNOT skip the lock", task 93), applied inside the lock.
//
// The resets are mocked rather than driven for real because the property under
// test is about control flow, not about what any one of them clears: each has
// its own coverage, and a test that needed five real stores in a failing state
// would be testing those instead of this.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPersonIdentityState,
  resetPersonIdentityState,
  setPersonIdentityState,
} from "../../src/components/sync/personIdentityState";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const throwing = () => {
  throw new Error("teardown step failed");
};

const resetGraphLayoutOnLock = vi.fn();
const resetVimStateOnLock = vi.fn();
const releaseAttachmentUrls = vi.fn();
const resetTaskIndexCache = vi.fn();
const clearAgentForLock = vi.fn();

vi.mock("../../src/notes/graphLayoutPersist", () => ({
  resetGraphLayoutOnLock: () => resetGraphLayoutOnLock(),
  flushGraphLayoutNow: () => Promise.resolve(),
}));
vi.mock("../../src/editor/vim", () => ({
  resetVimStateOnLock: () => resetVimStateOnLock(),
}));
vi.mock("../../src/platform/attachments", () => ({
  releaseAttachmentUrls: () => releaseAttachmentUrls(),
}));
vi.mock("../../src/notes/taskIndex", () => ({
  resetTaskIndexCache: () => resetTaskIndexCache(),
}));
vi.mock("../../src/notes/agent/agentStore", () => ({
  clearAgentForLock: () => clearAgentForLock(),
}));

const { lockVault } = await import("../../src/lib/vault-unlock");

/** Every reset the lock runs, in the order `lockVault` runs them. */
const STEPS = [
  resetGraphLayoutOnLock,
  resetVimStateOnLock,
  releaseAttachmentUrls,
  clearAgentForLock,
  resetTaskIndexCache,
];

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined);
  resetPersonIdentityState();
  for (const step of STEPS) step.mockReset().mockImplementation(() => {});
});

describe("lockVault reaches the lock", () => {
  it("issues the lock IPC when every teardown step succeeds", async () => {
    await lockVault();
    expect(invokeMock).toHaveBeenCalledWith("plugin:vault-unlock|lock");
  });

  it.each([0, 1, 2, 3, 4])("still issues it when step %i throws", async (i) => {
    STEPS[i].mockImplementation(throwing);
    await lockVault();
    expect(
      invokeMock,
      "a failed cache reset must never be what leaves root_key in the slot",
    ).toHaveBeenCalledWith("plugin:vault-unlock|lock");
  });

  it("runs the LATER steps too, rather than stopping at the first throw", async () => {
    // The weaker fix (one try/catch around the whole block) would satisfy every
    // case above and still skip four wipes. Each step clears a different piece
    // of plaintext-derived state that outlives the slot, so "the lock happened"
    // is not the whole property.
    STEPS[0].mockImplementation(throwing);
    await lockVault();
    for (const step of STEPS.slice(1)) expect(step).toHaveBeenCalledTimes(1);
  });

  it("clears the person identity on a normal lock", async () => {
    setPersonIdentityState({ ready: true, ownerCode: "public-code" });
    await lockVault();
    expect(getPersonIdentityState()).toEqual({ ready: false, ownerCode: null });
  });

  it("still rejects when the IPC itself fails", async () => {
    // The guard is scoped to the local steps on purpose. A failing lock command
    // is a different fact, and a caller that wants to know must still be able
    // to: swallowing it here would make every call site unable to tell a
    // completed lock from an attempted one.
    invokeMock.mockRejectedValue(new Error("worker gone"));
    await expect(lockVault()).rejects.toThrow("worker gone");
  });
});
