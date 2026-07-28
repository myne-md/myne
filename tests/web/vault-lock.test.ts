// Single-tab vault lock (phase3-web-client task 21).
//
// Driven through a fake `LockManager` rather than the real one: a test that
// needed two browsing contexts would not be a unit test, and `LockManager` is
// not constructible. The fake implements the two behaviours this module depends
// on — exclusivity, and `ifAvailable` handing the callback `null` instead of
// waiting — so a change in how the module uses the API shows up here.

import { describe, expect, it } from "vitest";
import {
  acquireVaultLock,
  vaultLockName,
  waitForVaultLockRelease,
  type LockManagerLike,
} from "../../web/src/vault-lock";

/** Minimal exclusive-lock manager: one holder per name, FIFO waiters. */
function fakeLocks(): LockManagerLike & { heldBy(name: string): boolean } {
  const held = new Set<string>();
  const waiters = new Map<string, Array<() => void>>();

  function grant(name: string, cb: (lock: unknown) => Promise<unknown>) {
    held.add(name);
    void Promise.resolve(cb({ name })).finally(() => {
      held.delete(name);
      const q = waiters.get(name);
      const next = q?.shift();
      if (next) next();
    });
  }

  return {
    heldBy: (name) => held.has(name),
    request(name, options, callback) {
      if (options.ifAvailable) {
        if (held.has(name)) return Promise.resolve(callback(null));
        grant(name, callback);
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const run = () => {
          grant(name, callback);
          resolve(undefined);
        };
        if (options.signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        options.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        if (!held.has(name)) run();
        else (waiters.get(name) ?? waiters.set(name, []).get(name)!).push(run);
      });
    },
  };
}

const VAULT = "vault-abc";

describe("vault lock — single-tab guarantee", () => {
  it("the first tab acquires and holds", async () => {
    const locks = fakeLocks();
    const r = await acquireVaultLock(VAULT, locks);
    expect(r.held).toBe(true);
    expect(locks.heldBy(vaultLockName(VAULT))).toBe(true);
  });

  it("a second tab is refused with 'open-elsewhere' and never holds the lock", async () => {
    const locks = fakeLocks();
    const first = await acquireVaultLock(VAULT, locks);
    expect(first.held).toBe(true);

    const second = await acquireVaultLock(VAULT, locks);
    // The load-bearing assertion: the second tab does not take over. If this
    // ever flips to `held: true`, two contexts write the same OPFS container.
    expect(second).toEqual({ held: false, reason: "open-elsewhere" });
  });

  it("releasing lets the next tab in", async () => {
    const locks = fakeLocks();
    const first = await acquireVaultLock(VAULT, locks);
    if (!first.held) throw new Error("precondition: first tab should hold");

    expect((await acquireVaultLock(VAULT, locks)).held).toBe(false);

    first.lock.release();
    await Promise.resolve();

    const third = await acquireVaultLock(VAULT, locks);
    expect(third.held).toBe(true);
  });

  it("release is idempotent — a double release cannot free someone else's lock", async () => {
    const locks = fakeLocks();
    const a = await acquireVaultLock(VAULT, locks);
    if (!a.held) throw new Error("precondition");
    a.lock.release();
    await Promise.resolve();

    const b = await acquireVaultLock(VAULT, locks);
    expect(b.held).toBe(true);

    a.lock.release(); // stale handle, second call
    await Promise.resolve();

    // b still holds — a stale release must not have freed it.
    expect(locks.heldBy(vaultLockName(VAULT))).toBe(true);
    expect((await acquireVaultLock(VAULT, locks)).held).toBe(false);
  });

  it("different vaults do not contend", async () => {
    const locks = fakeLocks();
    expect((await acquireVaultLock("vault-1", locks)).held).toBe(true);
    expect((await acquireVaultLock("vault-2", locks)).held).toBe(true);
  });

  it("reports 'unsupported' rather than pretending to hold, when Web Locks is absent", async () => {
    const r = await acquireVaultLock(VAULT, null);
    expect(r).toEqual({ held: false, reason: "unsupported" });
  });

  it("the lock name is namespaced to Myne and to the vault", () => {
    expect(vaultLockName("v1")).toBe("myne.vault.v1");
    expect(vaultLockName("v1")).not.toBe(vaultLockName("v2"));
  });
});

describe("vault lock — waiting for release", () => {
  it("resolves once the holder releases, and does not keep the lock itself", async () => {
    const locks = fakeLocks();
    const held = await acquireVaultLock(VAULT, locks);
    if (!held.held) throw new Error("precondition");

    const ac = new AbortController();
    let freed = false;
    const waiting = waitForVaultLockRelease(VAULT, ac.signal, locks).then(() => {
      freed = true;
    });

    expect(freed).toBe(false);
    held.lock.release();
    await waiting;
    expect(freed).toBe(true);

    // The waiter observed the edge and let go — otherwise the "open elsewhere"
    // screen would silently steal the lock from the user's next real tab.
    const next = await acquireVaultLock(VAULT, locks);
    expect(next.held).toBe(true);
  });

  it("an aborted wait rejects instead of resolving as 'now free'", async () => {
    const locks = fakeLocks();
    const held = await acquireVaultLock(VAULT, locks);
    if (!held.held) throw new Error("precondition");

    const ac = new AbortController();
    const waiting = waitForVaultLockRelease(VAULT, ac.signal, locks);
    ac.abort();
    await expect(waiting).rejects.toThrow();
  });

  it("is a no-op when Web Locks is absent", async () => {
    await expect(waitForVaultLockRelease(VAULT, new AbortController().signal, null)).resolves.toBeUndefined();
  });
});
