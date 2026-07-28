// Outliving a dead Worker's exclusive lock (phase3-web-client task 82).
//
// Every OPFS operation acquires and releases its own sync access handle in a
// `finally`, so a lock cannot leak from an ordinary failure. It CAN leak from an
// abnormal one: a wasm panic, an `onerror`, the browser reclaiming the Worker
// under memory pressure — the `finally` never runs. The browser releases the
// handle when it tears the agent down, but not instantaneously, and the
// replacement Worker starts immediately and reads `vault.meta` first thing.
//
// Without the retry that race surfaces as an unlock failing with
// `NoModificationAllowedError` on a vault that is completely intact — and failing
// again, because a user's retry is faster than a teardown.
//
// The bound is the other half of the design: a genuinely contended file is two
// tabs, which task 21's Web Lock exists to prevent, and if that ever fails open
// this must SURFACE the contention rather than hide it.

import { describe, expect, it, vi } from "vitest";
import { acquireSyncHandle } from "../../web/src/worker/opfs";

function domException(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

/** A file handle whose first `failures` acquisitions throw `name`. */
function flakyFile(failures: number, name = "NoModificationAllowedError") {
  let calls = 0;
  const handle = { marker: "acquired" };
  return {
    calls: () => calls,
    file: {
      createSyncAccessHandle: vi.fn(async () => {
        calls++;
        if (calls <= failures) throw domException(name);
        return handle;
      }),
    } as unknown as FileSystemFileHandle,
    handle,
  };
}

describe("sync access handle acquisition", () => {
  it("succeeds first try when the file is free", async () => {
    const f = flakyFile(0);
    await expect(acquireSyncHandle(f.file)).resolves.toBe(f.handle);
    expect(f.calls()).toBe(1);
  });

  it("outlives a stale lock left by a dead Worker", async () => {
    // Three failures then success — the shape of a teardown draining while the
    // replacement instance is already reading.
    const f = flakyFile(3);
    await expect(acquireSyncHandle(f.file)).resolves.toBe(f.handle);
    expect(f.calls()).toBe(4);
  });

  it("gives up rather than hanging on a genuinely held lock", async () => {
    // Two tabs. Task 21's Web Lock is what prevents this; if it ever fails open,
    // surfacing the contention is right and hiding it behind an unbounded retry
    // is not.
    const f = flakyFile(Number.MAX_SAFE_INTEGER);
    await expect(acquireSyncHandle(f.file)).rejects.toThrow();
    // Bounded: the initial attempt plus the fixed delay ladder, no more.
    expect(f.calls()).toBeLessThanOrEqual(6);
  });

  it("does not retry a NotFound or a full store", async () => {
    // Both are clear answers. Retrying either turns a clear answer into a
    // delayed one — and a full store cannot empty itself during the ladder.
    for (const name of ["NotFoundError", "QuotaExceededError"]) {
      const f = flakyFile(Number.MAX_SAFE_INTEGER, name);
      await expect(acquireSyncHandle(f.file)).rejects.toThrow();
      expect(f.calls(), `${name} must not be retried`).toBe(1);
    }
  });
});
